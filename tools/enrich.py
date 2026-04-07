#!/usr/bin/env python3
"""Enrich raw Figma JSON with semantic names, color tokens, and grouping.

Deterministic script — no AI, no element loss.
Every raw element appears exactly once in the output.
"""

import json
import sys
import os
import copy

# Color tokens: name -> (r, g, b) normalized 0-1
COLOR_TOKENS = {
    'primaryColor': (0.843, 0.047, 0.094),      # #D70C18
    'scaffoldBackground': (0.961, 0.961, 0.961), # #F5F5F5
    'cardBackground': (1.0, 1.0, 1.0),           # #FFFFFF
    'topText': (0.137, 0.090, 0.090),             # #231717
    'subText': (0.533, 0.533, 0.533),             # #888888
    'subTextWeak': (0.733, 0.733, 0.733),         # #BBBBBB
    'iconSecondary': (0.439, 0.439, 0.439),       # #707070
    'textSecondary': (0.263, 0.263, 0.263),        # #434343
    'textDark': (0.333, 0.333, 0.333),            # #555555
    'primaryGradationEnd': (1.0, 0.514, 0.212),   # #FF8336
}

TOLERANCE = 0.03


def match_color(fill):
    """Match a fill's color to a known token."""
    if not fill or fill.get('type') != 'SOLID':
        return None
    c = fill.get('color', {})
    r, g, b = c.get('r', -1), c.get('g', -1), c.get('b', -1)
    for name, (tr, tg, tb) in COLOR_TOKENS.items():
        if abs(r - tr) < TOLERANCE and abs(g - tg) < TOLERANCE and abs(b - tb) < TOLERANCE:
            return name
    return None


def is_bottomnav_element(el):
    """Check if element is a BottomNavigationBar element by name/content AND position."""
    name = el.get('_orig_name', el.get('name', ''))
    chars = el.get('characters', '')
    y = el.get('_abs_y', el.get('y', 0))
    w = el.get('width', 0)
    h = el.get('height', 0)

    # Must be in BottomNav Y range (>= 760)
    if y < 760:
        return False

    # BottomNav background: full-width Material with height ~90
    if name == 'Material' and w > 350 and h <= 100:
        return True
    # Tab icons (asset images with tab_ in name)
    if 'icon_tab_' in name.lower():
        return True
    # Tab labels
    if chars in ('TOP', 'メッセージ', 'シナリオ', 'ラーニング'):
        return True
    # Icon widgets in nav area (scenario icon etc) - 24x24 icons
    if name.startswith('Icon:') and el.get('width', 0) == 24 and el.get('height', 0) == 24:
        return True
    # Empty text overlapping icon (Figma text placeholder for icon)
    if el.get('type') == 'TEXT' and not chars.strip() and el.get('width', 0) == 24 and el.get('height', 0) == 24:
        return True
    return False


def is_myagent_element(el):
    """Check if element is a MyAgent banner element."""
    name = el.get('_orig_name', el.get('name', '')).lower()
    chars = el.get('characters', '')
    y = el.get('_abs_y', el.get('y', 0))
    h = el.get('height', 0)
    if 'my_agent' in name:
        return True
    if 'マイエージェント' in chars:
        return True
    # Gradient DecoratedBox in MyAgent area (floating button background)
    if (name == 'decoratedbox' and 680 < y < 760 and h < 60
            and 'GRADIENT' in str(el.get('fills', '')).upper()):
        return True
    return False


def semantic_name(el, idx, all_elements):
    """Generate semantic name based on position, content, and type."""
    name = el.get('name', '')
    chars = el.get('characters', '')
    x, y = el.get('x', 0), el.get('y', 0)
    w, h = el.get('width', 0), el.get('height', 0)

    # AppBar region (y < 108)
    if y < 108 and h < 120:
        if 'logo' in name.lower():
            return 'AppBar:Logo'
        if 'user' in name.lower():
            return 'AppBar:UserIcon'
        if name == 'Material' and w > 350:
            return 'AppBar:Background'

    # Full-screen backgrounds
    if x == 0 and y == 0 and w > 380:
        if h > 840:
            return 'Background:Scaffold'
        if h > 700:
            return 'Background:Body'

    # Gradient banner (107 < y < 210)
    if 100 < y < 210 and chars:
        if '様' in chars:
            return 'UserInfo:Suffix'
        if 'ID' == chars.strip():
            return 'UserInfo:IDLabel'
        if chars.strip().replace(' ', '').isdigit():
            return 'UserInfo:IDValue'
        if 'レポート' in chars:
            return 'GradientBanner:ReportButton'
        if len(chars) > 1 and y < 170:
            return 'UserInfo:Name'
    if 100 < y < 210 and 'Gradient' in str(el.get('fills', '')):
        return 'GradientBanner:Background'
    if 100 < y < 210 and name == 'DecoratedBox' and w > 300:
        return 'GradientBanner:Background'
    if 100 < y < 210 and name == 'PhysicalShape':
        return 'GradientBanner:ReportButtonBg'

    # Bottom nav — use content-based detection, not Y-based
    if is_bottomnav_element(el):
        return f'BottomNav:{name}'

    # Section titles (text with specific content)
    section_map = {
        '新着スカウト': 'ScoutSection:Title',
        'おすすめ案件': 'RecommendSection:Title',
        '視聴中の学習コース': 'LearningSection:Title',
        'ピックアップコラム': 'ColumnSection:Title',
        'セミナーのご案内': 'SeminarSection:Title',
        'キャリアの基礎知識': 'ReportSection:Title',
    }
    for key, sname in section_map.items():
        if key in chars:
            return sname

    # MyAgent banner
    if is_myagent_element(el):
        if 'Image' in name:
            return 'MyAgent:Icon'
        return 'MyAgent:SelectText'

    # Keep original name
    return name


def group_elements(elements):
    """Group elements into frames by section, without losing any.

    Strategy:
    1. Identify section titles and their Y positions
    2. Use those to define Y ranges for content sections
    3. Use CONTENT-BASED detection for AppBar, BottomNav, MyAgent
       (not hard-coded Y ranges, which break with scrollable content)
    """
    # First pass: identify section title positions
    section_starts = {}
    for i, el in enumerate(elements):
        chars = el.get('characters', '')
        y = el.get('_abs_y', el.get('y', 0))
        if '新着スカウト' in chars:
            section_starts['scout'] = y
        elif 'おすすめ案件' in chars:
            section_starts['recommend'] = y
        elif '視聴中の学習コース' in chars:
            section_starts['learning'] = y
        elif 'ピックアップコラム' in chars:
            section_starts['column'] = y
        elif 'セミナーのご案内' in chars:
            section_starts['seminar'] = y
        elif 'キャリアの基礎知識' in chars:
            section_starts['report'] = y

    # Define Y-ranges for each content section
    sorted_sections = sorted(section_starts.items(), key=lambda x: x[1])
    section_ranges = {}
    for idx_s, (name, start_y) in enumerate(sorted_sections):
        if idx_s + 1 < len(sorted_sections):
            end_y = sorted_sections[idx_s + 1][1]
        else:
            end_y = 99999  # Last section extends to end of content
        section_ranges[name] = (start_y - 5, end_y - 5)

    # Assign elements to groups
    assigned = [False] * len(elements)
    frame_groups = {}

    # Special groups
    appbar_els = []
    banner_els = []
    bottomnav_els = []
    myagent_els = []
    backgrounds = []

    for i, el in enumerate(elements):
        # Use absolute coords for grouping (semantic_name already ran)
        x = el.get('_abs_x', el.get('x', 0))
        y = el.get('_abs_y', el.get('y', 0))
        w, h = el.get('width', 0), el.get('height', 0)
        name = el.get('_orig_name', el.get('name', ''))

        # Full-screen backgrounds (always ungrouped)
        if x == 0 and y == 0 and w > 380 and h > 700:
            backgrounds.append(el)
            assigned[i] = True
            continue

        # AppBar: elements above the banner, small height
        if y < 108 and h < 120 and not (w > 380 and h > 200):
            appbar_els.append((i, el))
            assigned[i] = True
            continue

        # BottomNav: content-based + position detection
        if is_bottomnav_element(el):
            bottomnav_els.append((i, el))
            assigned[i] = True
            continue

        # MyAgent: content-based detection (includes gradient DecoratedBox)
        if is_myagent_element(el):
            myagent_els.append((i, el))
            assigned[i] = True
            continue

        # Gradient banner area (107-210)
        if 100 < y < 210 and h < 150:
            banner_els.append((i, el))
            assigned[i] = True
            continue

        # Content sections by Y range
        for sec_name, (sy, ey) in section_ranges.items():
            if sy <= y < ey:
                if sec_name not in frame_groups:
                    frame_groups[sec_name] = []
                frame_groups[sec_name].append((i, el))
                assigned[i] = True
                break

    # Collect unassigned elements
    ungrouped = []
    for i, el in enumerate(elements):
        if not assigned[i]:
            ungrouped.append(el)

    # Build output
    result = []

    # Add backgrounds first
    for el in backgrounds:
        result.append(copy.deepcopy(el))

    # Add ungrouped
    for el in ungrouped:
        result.append(copy.deepcopy(el))

    # Add frames
    def make_frame(name, el_list):
        if not el_list:
            return None
        children = [copy.deepcopy(el) for _, el in el_list]
        # Calculate frame bounds
        min_x = min(el.get('x', 0) for _, el in el_list)
        min_y = min(el.get('y', 0) for _, el in el_list)
        max_x = max(el.get('x', 0) + el.get('width', 0) for _, el in el_list)
        max_y = max(el.get('y', 0) + el.get('height', 0) for _, el in el_list)
        # Make children relative to frame
        for child in children:
            child['x'] = round(child.get('x', 0) - min_x, 1)
            child['y'] = round(child.get('y', 0) - min_y, 1)
        return {
            'type': 'FRAME',
            'name': name,
            'x': round(min_x, 1),
            'y': round(min_y, 1),
            'width': round(max_x - min_x, 1),
            'height': round(max_y - min_y, 1),
            'fills': [],
            'children': children,
        }

    for name, els in [
        ('Frame:AppBar', appbar_els),
        ('Frame:GradientBanner', banner_els),
    ]:
        f = make_frame(name, els)
        if f:
            result.append(f)

    # Content sections in order
    for sec_name in ['scout', 'recommend', 'learning', 'column', 'seminar', 'report']:
        if sec_name in frame_groups:
            f = make_frame(f'Frame:{sec_name.capitalize()}Section', frame_groups[sec_name])
            if f:
                result.append(f)

    for name, els in [
        ('Frame:MyAgent', myagent_els),
        ('Frame:BottomNav', bottomnav_els),
    ]:
        f = make_frame(name, els)
        if f:
            result.append(f)

    return result


def enrich(input_path, output_path):
    with open(input_path) as f:
        data = json.load(f)

    elements = data['root']['children']
    total_input = len(elements)
    print(f'Input: {total_input} elements')

    # Save original data for grouping before any modifications
    for el in elements:
        el['_abs_x'] = el.get('x', 0)
        el['_abs_y'] = el.get('y', 0)
        el['_orig_name'] = el.get('name', '')

    # Step 1: Group into frames FIRST (uses original names and absolute coords)
    grouped = group_elements(elements)

    # Step 2: Semantic naming + color tokens (on grouped structure)
    def apply_enrichment(items):
        for i, el in enumerate(items):
            if el.get('type') == 'FRAME' and 'children' in el:
                apply_enrichment(el['children'])
            else:
                # Restore absolute coords for semantic_name, then put relative back
                orig_x, orig_y = el.get('_abs_x', el.get('x', 0)), el.get('_abs_y', el.get('y', 0))
                rel_x, rel_y = el.get('x', 0), el.get('y', 0)
                el['x'], el['y'] = orig_x, orig_y
                el['name'] = semantic_name(el, i, items)
                el['x'], el['y'] = rel_x, rel_y

                fills = el.get('fills', [])
                if fills and isinstance(fills, list) and len(fills) > 0:
                    token = match_color(fills[0])
                    if token:
                        el['_colorToken'] = token

    apply_enrichment(grouped)

    # Step 3: Clean up temp fields
    def clean_temp(items):
        for item in items:
            item.pop('_abs_x', None)
            item.pop('_abs_y', None)
            item.pop('_orig_name', None)
            if item.get('type') == 'FRAME' and 'children' in item:
                clean_temp(item['children'])
    clean_temp(grouped)

    # Verify no elements lost
    def count_elements(items):
        total = 0
        for item in items:
            if item.get('type') == 'FRAME' and 'children' in item:
                total += count_elements(item['children'])
            else:
                total += 1
        return total

    total_output = count_elements(grouped)
    print(f'Output: {total_output} elements in {len(grouped)} top-level nodes')
    if total_output != total_input:
        print(f'WARNING: Element count mismatch! Input={total_input}, Output={total_output}')

    # Build output
    output = {
        'metadata': {
            'exportDate': data.get('metadata', {}).get('exportDate', ''),
            'method': 'devtools',
            'screenSize': data.get('metadata', {}).get('screenSize', {}),
        },
        'root': {
            'type': 'FRAME',
            'name': 'TopPage',
            'width': data['root']['width'],
            'height': data['root']['height'],
            'fills': data['root'].get('fills', []),
            'clipsContent': True,
            'children': grouped,
        },
    }

    with open(output_path, 'w') as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    size = os.path.getsize(output_path)
    print(f'Written: {output_path} ({size:,} bytes)')

    # Print structure summary
    print('\nStructure:')
    for c in grouped:
        if c.get('type') == 'FRAME':
            children_info = []
            for ch in c.get('children', []):
                ch_name = ch.get('name', '?')
                ch_chars = ch.get('characters', '')
                children_info.append(f'{ch_name}' + (f'({ch_chars[:15]})' if ch_chars else ''))
            print(f'  FRAME: {c["name"]} ({len(c.get("children",[]))} children) at y={c.get("y",0)}')
            for ci in children_info:
                print(f'    - {ci}')
        else:
            print(f'  {c["type"]}: {c["name"]}')


if __name__ == '__main__':
    input_path = sys.argv[1] if len(sys.argv) > 1 else \
        '/Users/shotashirai/Documents/flutter_to_figma/example-app/test/figma_output/top_page_devtools_raw.json'
    output_path = input_path.replace('_raw.json', '_enriched.json')
    enrich(input_path, output_path)
