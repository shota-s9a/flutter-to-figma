/**
 * Converts Flutter Inspector DiagnosticsNode tree to Figma-compatible JSON.
 *
 * Parses property descriptions (Color, EdgeInsets, BorderRadius, etc.)
 * from Flutter's debugFillProperties output.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DiagNode, DiagProperty, FlutterInspector } from "./inspector.js";

/**
 * Decoration info extracted from Dart source code per Widget class.
 * Used to fill in gradient/shadow/border that Inspector API can't expose.
 */
export interface WidgetDecoration {
  className: string;
  filePath: string;
  gradient?: ParsedGradient;
  shadow?: ParsedShadow;
  border?: ParsedBorder;
  borderRadius?: number;
  backgroundColor?: { r: number; g: number; b: number; a: number };
}

/** Resolved theme tokens from Dart source (used to substitute context.spacing.md etc.) */
export interface ThemeTokens {
  spacing: Record<string, number>;
  radius: Record<string, number>;
  colors: Record<string, { r: number; g: number; b: number; a: number }>;
}

/**
 * Collect all .dart files under a directory tree, excluding generated files.
 */
function collectDartFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (d: string) => {
    try {
      for (const entry of readdirSync(d)) {
        if (entry.startsWith(".")) continue;
        const full = join(d, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
          // Skip common build/generated dirs
          if (
            entry === "build" ||
            entry === ".dart_tool" ||
            entry === "node_modules" ||
            entry === "generated"
          ) {
            continue;
          }
          walk(full);
        } else if (
          entry.endsWith(".dart") &&
          !entry.endsWith(".g.dart") &&
          !entry.endsWith(".freezed.dart") &&
          !entry.endsWith(".gen.dart")
        ) {
          files.push(full);
        }
      }
    } catch {
      // skip unreadable dirs
    }
  };
  walk(root);
  return files;
}

/**
 * Walk all .dart files under `projectRoot/lib` and extract per-class decoration info.
 * Looks for any `class XXX extends *Widget` block (generic, matches any
 * custom widget base class: StatelessWidget, ConsumerStatefulWidget, etc.)
 * and finds BoxDecoration / LinearGradient / BoxShadow within them.
 */
export function extractDecorationsFromProject(
  projectRoot: string,
  themeTokens?: ThemeTokens
): Map<string, WidgetDecoration> {
  const decorations = new Map<string, WidgetDecoration>();
  const libDir = join(projectRoot, "lib");
  if (!existsSync(libDir)) return decorations;

  const dartFiles = collectDartFiles(libDir);

  for (const file of dartFiles) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    // Match any class extending a Widget-like base class.
    // Examples: StatelessWidget, StatefulWidget, HookWidget, HookConsumerWidget,
    // ConsumerStatefulWidget, RiverpodStatelessWidget, custom MyBaseWidget, etc.
    const classMatches = content.matchAll(
      /class\s+(_?\w+)\s+extends\s+\w*Widget\b/g
    );

    for (const classMatch of classMatches) {
      const className = classMatch[1];
      const startIdx = classMatch.index ?? 0;

      // Find the end of this class (matching braces)
      const classBody = extractClassBody(content, startIdx);
      if (!classBody) continue;

      const dec: WidgetDecoration = {
        className,
        filePath: file,
      };

      // Parse LinearGradient
      const gradMatch = classBody.match(
        /LinearGradient\s*\(([\s\S]*?)\)\s*[,)]/
      );
      if (gradMatch) {
        const gradient = parseLinearGradientFromSource(gradMatch[0], themeTokens);
        if (gradient) dec.gradient = gradient;
      }

      // Parse BoxShadow
      const shadowMatch = classBody.match(/BoxShadow\s*\(([\s\S]*?)\)/);
      if (shadowMatch) {
        const shadow = parseBoxShadowFromSource(shadowMatch[0], themeTokens);
        if (shadow) dec.shadow = shadow;
      }

      // Parse Border.all
      const borderMatch = classBody.match(/Border\.all\s*\(([\s\S]*?)\)/);
      if (borderMatch) {
        const border = parseBorderFromSource(borderMatch[0], themeTokens);
        if (border) dec.border = border;
      }

      // Parse borderRadius (BorderRadius.circular(N) or radius.xx)
      const radiusMatch = classBody.match(
        /BorderRadius\.circular\s*\(\s*(?:([0-9.]+)|context\.radius\.(\w+)|radius\.(\w+))\s*\)/
      );
      if (radiusMatch) {
        if (radiusMatch[1]) dec.borderRadius = parseFloat(radiusMatch[1]);
        else if (themeTokens) {
          const tokenName = radiusMatch[2] ?? radiusMatch[3];
          if (tokenName && themeTokens.radius[tokenName] != null) {
            dec.borderRadius = themeTokens.radius[tokenName];
          }
        }
      }

      // Only register if we found something useful
      if (dec.gradient || dec.shadow || dec.border || dec.borderRadius != null) {
        decorations.set(className, dec);
      }
    }
  }

  return decorations;
}

/** Extract a class body by counting braces from a starting position */
function extractClassBody(content: string, startIdx: number): string | null {
  // Find the first '{' after startIdx
  const braceIdx = content.indexOf("{", startIdx);
  if (braceIdx === -1) return null;
  let depth = 1;
  let i = braceIdx + 1;
  while (i < content.length && depth > 0) {
    const c = content[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    i++;
  }
  return content.substring(braceIdx, i);
}

/** Resolve a single token reference like `foo.bar` or `foo.bar.baz` → Color */
function resolveColorRef(
  ref: string,
  tokens?: ThemeTokens
): { r: number; g: number; b: number; a: number } | null {
  if (!tokens) return null;
  // Try the last dot segment first (most specific): colorScheme.primary → "primary"
  const segments = ref.split(".");
  for (let i = segments.length - 1; i >= 0; i--) {
    const name = segments[i];
    if (tokens.colors[name]) return tokens.colors[name];
  }
  return null;
}

/** Parse LinearGradient from source code (handles any theme token namespace) */
function parseLinearGradientFromSource(
  src: string,
  tokens?: ThemeTokens
): ParsedGradient | null {
  const colorRefs: { r: number; g: number; b: number; a: number }[] = [];
  // Direct Color(0x...) literals
  const directColors = [...src.matchAll(/Color\(0x([0-9a-fA-F]{8})\)/g)];
  for (const m of directColors) {
    const hex = m[1];
    colorRefs.push({
      a: parseInt(hex.substring(0, 2), 16) / 255,
      r: parseInt(hex.substring(2, 4), 16) / 255,
      g: parseInt(hex.substring(4, 6), 16) / 255,
      b: parseInt(hex.substring(6, 8), 16) / 255,
    });
  }
  // Any identifier chain ending in .name where `name` is a known color token.
  // Examples: colorScheme.primary, themeColors.xxx, AppColors.primary, theme.danger
  if (tokens) {
    const tokenRefs = [
      ...src.matchAll(/\b(?:[a-zA-Z_$][\w$]*)(?:\.[a-zA-Z_$][\w$]*)+/g),
    ];
    for (const m of tokenRefs) {
      const resolved = resolveColorRef(m[0], tokens);
      if (resolved) colorRefs.push(resolved);
    }
  }

  if (colorRefs.length < 2) return null;

  const stopsMatch = src.match(/stops:\s*(?:const\s+)?\[([0-9.,\s]+)\]/);
  const stops = stopsMatch
    ? stopsMatch[1].split(",").map((s) => parseFloat(s.trim()))
    : colorRefs.map((_, i) => i / Math.max(1, colorRefs.length - 1));
  const beginMatch = src.match(/begin:\s*Alignment\.(\w+)/);
  const endMatch = src.match(/end:\s*Alignment\.(\w+)/);

  return {
    type: "GRADIENT_LINEAR",
    colors: colorRefs,
    stops,
    beginAlignment: beginMatch?.[1] ?? "topLeft",
    endAlignment: endMatch?.[1] ?? "bottomRight",
  };
}

function parseBoxShadowFromSource(
  src: string,
  tokens?: ThemeTokens
): ParsedShadow | null {
  let color: { r: number; g: number; b: number; a: number } | null = null;
  const direct = src.match(/Color\(0x([0-9a-fA-F]{8})\)/);
  if (direct) {
    const hex = direct[1];
    color = {
      a: parseInt(hex.substring(0, 2), 16) / 255,
      r: parseInt(hex.substring(2, 4), 16) / 255,
      g: parseInt(hex.substring(4, 6), 16) / 255,
      b: parseInt(hex.substring(6, 8), 16) / 255,
    };
  } else if (tokens) {
    // Try any identifier chain and resolve the last segment as a known color
    const tokenRefs = [
      ...src.matchAll(/\b(?:[a-zA-Z_$][\w$]*)(?:\.[a-zA-Z_$][\w$]*)+/g),
    ];
    for (const m of tokenRefs) {
      const resolved = resolveColorRef(m[0], tokens);
      if (resolved) {
        color = resolved;
        break;
      }
    }
  }
  if (!color) return null;

  const offsetMatch = src.match(/Offset\(([-0-9.]+),\s*([-0-9.]+)\)/);
  const blurMatch = src.match(/blurRadius:\s*([0-9.]+)/);
  const spreadMatch = src.match(/spreadRadius:\s*([0-9.]+)/);
  return {
    color,
    offsetX: offsetMatch ? parseFloat(offsetMatch[1]) : 0,
    offsetY: offsetMatch ? parseFloat(offsetMatch[2]) : 0,
    blurRadius: blurMatch ? parseFloat(blurMatch[1]) : 0,
    spreadRadius: spreadMatch ? parseFloat(spreadMatch[1]) : 0,
  };
}

function parseBorderFromSource(
  src: string,
  tokens?: ThemeTokens
): ParsedBorder | null {
  let color: { r: number; g: number; b: number; a: number } | null = null;
  const direct = src.match(/Color\(0x([0-9a-fA-F]{8})\)/);
  if (direct) {
    const hex = direct[1];
    color = {
      a: parseInt(hex.substring(0, 2), 16) / 255,
      r: parseInt(hex.substring(2, 4), 16) / 255,
      g: parseInt(hex.substring(4, 6), 16) / 255,
      b: parseInt(hex.substring(6, 8), 16) / 255,
    };
  } else if (tokens) {
    const tokenRefs = [
      ...src.matchAll(/\b(?:[a-zA-Z_$][\w$]*)(?:\.[a-zA-Z_$][\w$]*)+/g),
    ];
    for (const m of tokenRefs) {
      const resolved = resolveColorRef(m[0], tokens);
      if (resolved) {
        color = resolved;
        break;
      }
    }
  }
  if (!color) return null;
  const widthMatch = src.match(/width:\s*([0-9.]+)/);
  return { color, width: widthMatch ? parseFloat(widthMatch[1]) : 1 };
}

/**
 * Extract theme tokens from any Dart source files under `lib/`.
 * Scans the whole lib tree (not just theme dirs) and picks up:
 *   - Color constants: `name: Color(0xAARRGGBB)` / `static const Color name = Color(...)` / `final Color name = Color(...)`
 *   - Numeric tokens: `name: N.w/h/r/sp,` (ScreenUtil) / `static const double name = N;`
 * Classifies numeric tokens into `spacing` vs `radius` based on class context
 * (class name contains "Radius" / "Corner" → radius, else → spacing).
 * Returns tokens by name; the resolver uses the last dot segment.
 */
export function extractThemeTokens(projectRoot: string): ThemeTokens {
  const tokens: ThemeTokens = {
    spacing: {},
    radius: {},
    colors: {},
  };

  const libDir = join(projectRoot, "lib");
  if (!existsSync(libDir)) return tokens;

  const dartFiles = collectDartFiles(libDir);

  for (const file of dartFiles) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    // ── Color definitions ──
    // `name: Color(0xAARRGGBB)` (constructor arg / map entry)
    const colorMatches1 = content.matchAll(
      /(\w+):\s*Color\(0x([0-9A-Fa-f]{8})\)/g
    );
    for (const m of colorMatches1) {
      addColor(tokens, m[1], m[2]);
    }
    // `static const Color name = Color(0x...)`  / `final Color name = Color(0x...)`
    const colorMatches2 = content.matchAll(
      /(?:static\s+const|final|const)\s+Color\s+(\w+)\s*=\s*Color\(0x([0-9A-Fa-f]{8})\)/g
    );
    for (const m of colorMatches2) {
      addColor(tokens, m[1], m[2]);
    }
    // `static const Color name = Color(0x...);` inside a class
    const colorMatches3 = content.matchAll(
      /Color\s+get\s+(\w+)\s*=>\s*(?:const\s+)?Color\(0x([0-9A-Fa-f]{8})\)/g
    );
    for (const m of colorMatches3) {
      addColor(tokens, m[1], m[2]);
    }

    // ── Numeric tokens (spacing / radius) ──
    // Walk each class and classify numerics by class name heuristic
    const classMatches = [
      ...content.matchAll(
        /class\s+(\w+)(?:\s+extends[^{]*)?\s*\{/g
      ),
    ];
    for (const classMatch of classMatches) {
      const className = classMatch[1];
      const classBody = extractClassBody(content, classMatch.index ?? 0);
      if (!classBody) continue;

      const isRadiusClass = /Radius|Corner/i.test(className);
      const isSpacingClass =
        /Spacing|Padding|Margin|Gap|Sizing|Size|Dimension/i.test(className);

      // ScreenUtil style: `name: N.w,` or `name: N.h,` etc.
      const screenUtilMatches = classBody.matchAll(
        /(\w+):\s*([0-9.]+)\.[whrsp]+,/g
      );
      // `static const double name = N;` / `final double name = N;`
      const constDoubleMatches = classBody.matchAll(
        /(?:static\s+const|final|const)\s+(?:double|int)\s+(\w+)\s*=\s*([0-9.]+)/g
      );
      // `double get name => N;`  / `double get name => N.w;`
      const getterMatches = classBody.matchAll(
        /(?:double|int)\s+get\s+(\w+)\s*=>\s*([0-9.]+)(?:\.[whrsp]+)?/g
      );

      const allNumericMatches = [
        ...screenUtilMatches,
        ...constDoubleMatches,
        ...getterMatches,
      ];

      for (const m of allNumericMatches) {
        const name = m[1];
        const value = parseFloat(m[2]);
        if (isRadiusClass) {
          tokens.radius[name] = value;
        } else if (isSpacingClass) {
          tokens.spacing[name] = value;
        } else {
          // Fallback: guess by name
          if (/radius|corner/i.test(name)) {
            tokens.radius[name] = value;
          } else {
            tokens.spacing[name] = value;
          }
        }
      }
    }
  }

  return tokens;
}

function addColor(tokens: ThemeTokens, name: string, hex: string): void {
  if (tokens.colors[name]) return; // first occurrence wins (light theme)
  tokens.colors[name] = {
    a: parseInt(hex.substring(0, 2), 16) / 255,
    r: parseInt(hex.substring(2, 4), 16) / 255,
    g: parseInt(hex.substring(4, 6), 16) / 255,
    b: parseInt(hex.substring(6, 8), 16) / 255,
  };
}

/** Figma node (matches flutter-to-figma.v1.schema.json) */
export interface FigmaNode {
  type: "FRAME" | "TEXT" | "RECTANGLE" | "ELLIPSE";
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fills?: FigmaFill[];
  strokes?: FigmaStroke[];
  strokeWeight?: number;
  cornerRadius?: number;
  clipsContent?: boolean;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  effects?: FigmaEffect[];
  children?: FigmaNode[];
  // TEXT
  characters?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: number;
  textAlignHorizontal?: string;
  lineHeight?: number;
  // Image asset reference (resolved when possible)
  imageAssetPath?: string;
  imageNetworkUrl?: string;
  // Icon
  iconName?: string;
  iconCodepoint?: string;
}

type FigmaFill =
  | {
      type: "SOLID";
      color: { r: number; g: number; b: number };
      opacity?: number;
    }
  | {
      type: "GRADIENT_LINEAR";
      gradientStops: { color: { r: number; g: number; b: number; a: number }; position: number }[];
      gradientHandlePositions?: { x: number; y: number }[];
    }
  | {
      type: "IMAGE";
      imageAssetPath?: string;
      imageNetworkUrl?: string;
    };

interface FigmaStroke {
  type: "SOLID";
  color: { r: number; g: number; b: number };
  opacity?: number;
  weight?: number;
}

interface FigmaEffect {
  type: "DROP_SHADOW";
  color: { r: number; g: number; b: number; a: number };
  offset: { x: number; y: number };
  radius: number;
  spread?: number;
}

// ── Property parsers ──

/** Parse "Color(0xffRRGGBB)" or "Color(0xAARRGGBB)" */
export function parseColor(
  desc: string
): { r: number; g: number; b: number; a: number } | null {
  const match = desc.match(/Color\(0x([0-9a-fA-F]{8})\)/);
  if (!match) return null;
  const hex = match[1];
  const a = parseInt(hex.substring(0, 2), 16) / 255;
  const r = parseInt(hex.substring(2, 4), 16) / 255;
  const g = parseInt(hex.substring(4, 6), 16) / 255;
  const b = parseInt(hex.substring(6, 8), 16) / 255;
  return { r, g, b, a };
}

/** Parse "EdgeInsets(L, T, R, B)" or "EdgeInsets.all(N)" etc. */
export function parseEdgeInsets(
  desc: string
): { left: number; top: number; right: number; bottom: number } | null {
  // EdgeInsets.all(8.0)
  const allMatch = desc.match(/EdgeInsets\.all\(([0-9.]+)\)/);
  if (allMatch) {
    const v = parseFloat(allMatch[1]);
    return { left: v, top: v, right: v, bottom: v };
  }
  // EdgeInsets(L, T, R, B)
  const ltrb = desc.match(
    /EdgeInsets\(([0-9.]+),\s*([0-9.]+),\s*([0-9.]+),\s*([0-9.]+)\)/
  );
  if (ltrb) {
    return {
      left: parseFloat(ltrb[1]),
      top: parseFloat(ltrb[2]),
      right: parseFloat(ltrb[3]),
      bottom: parseFloat(ltrb[4]),
    };
  }
  // EdgeInsets.symmetric(horizontal: H, vertical: V)
  const sym = desc.match(
    /EdgeInsets\.symmetric\(.*?horizontal:\s*([0-9.]+).*?vertical:\s*([0-9.]+)/
  );
  if (sym) {
    const h = parseFloat(sym[1]);
    const v = parseFloat(sym[2]);
    return { left: h, top: v, right: h, bottom: v };
  }
  // EdgeInsets.only(left: L, top: T, right: R, bottom: B)
  const only = desc.match(/EdgeInsets\.only\(([^)]+)\)/);
  if (only) {
    const parts = only[1];
    const l = parts.match(/left:\s*([0-9.]+)/);
    const t = parts.match(/top:\s*([0-9.]+)/);
    const r = parts.match(/right:\s*([0-9.]+)/);
    const b = parts.match(/bottom:\s*([0-9.]+)/);
    return {
      left: l ? parseFloat(l[1]) : 0,
      top: t ? parseFloat(t[1]) : 0,
      right: r ? parseFloat(r[1]) : 0,
      bottom: b ? parseFloat(b[1]) : 0,
    };
  }
  return null;
}

/** Parse "BorderRadius.circular(N)" or "BorderRadius.all(Radius.circular(N))" */
export function parseBorderRadius(desc: string): number | null {
  const circular = desc.match(/BorderRadius\.circular\(([0-9.]+)\)/);
  if (circular) return parseFloat(circular[1]);
  const all = desc.match(/Radius\.circular\(([0-9.]+)\)/);
  if (all) return parseFloat(all[1]);
  return null;
}

/** Parse font weight from "FontWeight.wNNN" */
export function parseFontWeight(desc: string): number | null {
  const match = desc.match(/FontWeight\.w(\d+)/);
  if (match) return parseInt(match[1]);
  if (desc.includes("bold")) return 700;
  if (desc.includes("normal")) return 400;
  return null;
}

/** Parse "LinearGradient(...)" to a Figma GRADIENT_LINEAR fill */
export interface ParsedGradient {
  type: "GRADIENT_LINEAR";
  colors: { r: number; g: number; b: number; a: number }[];
  stops: number[];
  beginAlignment: string;
  endAlignment: string;
}

export function parseLinearGradient(desc: string): ParsedGradient | null {
  if (!desc.includes("LinearGradient")) return null;
  // Extract Color list
  const colorMatches = [...desc.matchAll(/Color\(0x([0-9a-fA-F]{8})\)/g)];
  if (colorMatches.length < 2) return null;
  const colors = colorMatches.map((m) => {
    const hex = m[1];
    return {
      a: parseInt(hex.substring(0, 2), 16) / 255,
      r: parseInt(hex.substring(2, 4), 16) / 255,
      g: parseInt(hex.substring(4, 6), 16) / 255,
      b: parseInt(hex.substring(6, 8), 16) / 255,
    };
  });
  // Extract stops [a, b, c]
  const stopsMatch = desc.match(/stops:\s*\[([0-9.,\s]+)\]/);
  const stops = stopsMatch
    ? stopsMatch[1].split(",").map((s) => parseFloat(s.trim()))
    : colors.map((_, i) => i / Math.max(1, colors.length - 1));
  // Extract begin/end alignment
  const beginMatch = desc.match(/begin:\s*Alignment\.(\w+)/);
  const endMatch = desc.match(/end:\s*Alignment\.(\w+)/);
  return {
    type: "GRADIENT_LINEAR",
    colors,
    stops,
    beginAlignment: beginMatch?.[1] ?? "topLeft",
    endAlignment: endMatch?.[1] ?? "bottomRight",
  };
}

/** Parse "BoxShadow(...)" — first shadow only */
export interface ParsedShadow {
  color: { r: number; g: number; b: number; a: number };
  offsetX: number;
  offsetY: number;
  blurRadius: number;
  spreadRadius: number;
}

export function parseBoxShadow(desc: string): ParsedShadow | null {
  if (!desc.includes("BoxShadow")) return null;
  const colorMatch = desc.match(/Color\(0x([0-9a-fA-F]{8})\)/);
  if (!colorMatch) return null;
  const hex = colorMatch[1];
  const color = {
    a: parseInt(hex.substring(0, 2), 16) / 255,
    r: parseInt(hex.substring(2, 4), 16) / 255,
    g: parseInt(hex.substring(4, 6), 16) / 255,
    b: parseInt(hex.substring(6, 8), 16) / 255,
  };
  const offsetMatch = desc.match(/Offset\(([-0-9.]+),\s*([-0-9.]+)\)/);
  const blurMatch = desc.match(/blurRadius:\s*([0-9.]+)/);
  const spreadMatch = desc.match(/spreadRadius:\s*([0-9.]+)/);
  return {
    color,
    offsetX: offsetMatch ? parseFloat(offsetMatch[1]) : 0,
    offsetY: offsetMatch ? parseFloat(offsetMatch[2]) : 0,
    blurRadius: blurMatch ? parseFloat(blurMatch[1]) : 0,
    spreadRadius: spreadMatch ? parseFloat(spreadMatch[1]) : 0,
  };
}

/** Parse "Border.all(color: ..., width: N)" or "BorderSide(...)" */
export interface ParsedBorder {
  color: { r: number; g: number; b: number; a: number };
  width: number;
}

export function parseBorder(desc: string): ParsedBorder | null {
  if (!desc.includes("Border") && !desc.includes("BorderSide")) return null;
  const colorMatch = desc.match(/Color\(0x([0-9a-fA-F]{8})\)/);
  if (!colorMatch) return null;
  const hex = colorMatch[1];
  const widthMatch = desc.match(/width:\s*([0-9.]+)/);
  return {
    color: {
      a: parseInt(hex.substring(0, 2), 16) / 255,
      r: parseInt(hex.substring(2, 4), 16) / 255,
      g: parseInt(hex.substring(4, 6), 16) / 255,
      b: parseInt(hex.substring(6, 8), 16) / 255,
    },
    width: widthMatch ? parseFloat(widthMatch[1]) : 1,
  };
}

/** Material Icons codepoint → name mapping (commonly used icons) */
const ICON_CODEPOINT_MAP: Record<string, string> = {
  e30b: "help_outline",
  e093: "arrow_back_ios",
  e355: "keyboard_arrow_right",
  e5cc: "chevron_right",
  e5cb: "chevron_left",
  e145: "add",
  e15b: "remove",
  e5cd: "close",
  e876: "check",
  e8b6: "search",
  e7fd: "person",
  e7fb: "people",
  e0be: "email",
  e0cd: "phone",
  e88e: "info",
  e000: "error",
  e002: "warning",
  e8b8: "settings",
  e8e7: "date_range",
  e878: "today",
  e616: "calendar_today",
  e5d3: "menu",
  e8b3: "share",
  e87d: "favorite",
  e87e: "favorite_border",
  e838: "star",
  e83a: "star_border",
  e3c9: "edit",
  e872: "delete",
  e2c4: "file_download",
  e2c6: "file_upload",
  e3b6: "image",
  e1db: "notifications",
  e7ee: "logout",
};

export function resolveIconName(iconDataDesc: string): string | null {
  // "IconData(U+0E30B)" or "IconData(U+0E093)"
  const match = iconDataDesc.match(/U\+0?([0-9A-Fa-f]{4,5})/);
  if (!match) return null;
  const codepoint = match[1].toLowerCase().padStart(4, "0");
  return ICON_CODEPOINT_MAP[codepoint] ?? null;
}

// ── Tree converter ──

/** Non-visual widget types to skip (pass children through) */
const TRANSPARENT_WIDGETS = new Set([
  "GestureDetector",
  "InkWell",
  "Semantics",
  "MergeSemantics",
  "ExcludeSemantics",
  "FocusScope",
  "Focus",
  "Listener",
  "MouseRegion",
  "RepaintBoundary",
  "KeyedSubtree",
  "Builder",
  "NotificationListener",
  "AnimatedBuilder",
  "ValueListenableBuilder",
]);

export class FigmaConverter {
  private decorations: Map<string, WidgetDecoration>;
  private themeTokens: ThemeTokens | null;
  /**
   * Stack of ancestor widget class names so leaf nodes (Container/DecoratedBox)
   * can match the closest parent widget that has a known decoration in source.
   */
  private ancestorStack: string[] = [];

  constructor(
    private inspector: FlutterInspector,
    options?: { projectRoot?: string }
  ) {
    if (options?.projectRoot) {
      this.themeTokens = extractThemeTokens(options.projectRoot);
      this.decorations = extractDecorationsFromProject(
        options.projectRoot,
        this.themeTokens
      );
    } else {
      this.themeTokens = null;
      this.decorations = new Map();
    }
  }

  /** Convert the full Flutter widget tree to Figma JSON */
  async convert(): Promise<{
    metadata: Record<string, unknown>;
    root: FigmaNode;
  }> {
    const rootTree = await this.inspector.getRootTree();
    const children = await this.convertChildren(rootTree.children ?? []);

    // Find screen bounds from children
    let maxW = 0;
    let maxH = 0;
    for (const child of children) {
      maxW = Math.max(maxW, child.x + child.width);
      maxH = Math.max(maxH, child.y + child.height);
    }

    return {
      metadata: {
        exportDate: new Date().toISOString(),
        method: "inspector_api_v1",
        screenSize: { width: maxW, height: maxH },
      },
      root: {
        type: "FRAME",
        name: "Screen",
        x: 0,
        y: 0,
        width: maxW || 390,
        height: maxH || 844,
        fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }],
        clipsContent: true,
        children,
      },
    };
  }

  private async convertChildren(nodes: DiagNode[]): Promise<FigmaNode[]> {
    const results: FigmaNode[] = [];
    for (const node of nodes) {
      const converted = await this.convertNode(node);
      results.push(...converted);
    }
    return results;
  }

  private async convertNode(node: DiagNode): Promise<FigmaNode[]> {
    const widgetType = node.description?.split("(")[0]?.trim() ?? "";

    // Skip non-visual widgets — pass children through
    if (TRANSPARENT_WIDGETS.has(widgetType)) {
      return this.convertChildren(node.children ?? []);
    }

    // Push to ancestor stack so descendants (Container/DecoratedBox) can find
    // the nearest user-defined widget class with a known decoration in source.
    const userClass = this.decorations.has(widgetType) ? widgetType : null;
    if (userClass) this.ancestorStack.push(userClass);

    // Get detailed info if objectId is available
    let props: DiagProperty[] = [];
    let layout: DiagNode | null = null;

    if (node.objectId) {
      try {
        const details = await this.inspector.getDetailsSubtree(
          node.objectId,
          1
        );
        props = details.properties ?? [];
        layout = await this.inspector.getLayoutExplorerNode(node.objectId);
      } catch {
        // Node may not have layout info
      }
    }

    const size = layout?.size ?? { width: 0, height: 0 };
    const offset = layout?.parentData ?? { offsetX: 0, offsetY: 0 };

    // Convert children first
    const children = await this.convertChildren(node.children ?? []);

    // Determine node type and extract visual properties
    const figmaNode = this.buildFigmaNode(
      widgetType,
      node,
      props,
      size,
      offset,
      children
    );

    // Pop ancestor stack
    if (userClass) this.ancestorStack.pop();

    if (figmaNode) return [figmaNode];

    // If we couldn't create a node, pass children through
    return children;
  }

  /** Get the nearest ancestor's decoration from the source-extracted map */
  private getAncestorDecoration(): WidgetDecoration | null {
    for (let i = this.ancestorStack.length - 1; i >= 0; i--) {
      const dec = this.decorations.get(this.ancestorStack[i]);
      if (dec) return dec;
    }
    return null;
  }

  private buildFigmaNode(
    widgetType: string,
    node: DiagNode,
    props: DiagProperty[],
    size: { width: number; height: number },
    offset: { offsetX: number; offsetY: number },
    children: FigmaNode[]
  ): FigmaNode | null {
    const base = {
      x: offset.offsetX,
      y: offset.offsetY,
      width: size.width,
      height: size.height,
    };

    // Text widgets
    if (widgetType === "Text" || widgetType === "RichText") {
      const textProp = props.find((p) => p.name === "data");
      const styleProp = props.find((p) => p.name === "style");
      const text = textProp?.description ?? node.name ?? "";

      const textNode: FigmaNode = {
        type: "TEXT",
        name: `Text: ${text.substring(0, 30)}`,
        ...base,
        characters: text,
      };

      if (styleProp?.description) {
        const colorMatch = parseColor(styleProp.description);
        if (colorMatch) {
          textNode.fills = [
            {
              type: "SOLID",
              color: { r: colorMatch.r, g: colorMatch.g, b: colorMatch.b },
              opacity: colorMatch.a,
            },
          ];
        }
        const weightMatch = parseFontWeight(styleProp.description);
        if (weightMatch) textNode.fontWeight = weightMatch;
        const sizeMatch = styleProp.description.match(/size:\s*([0-9.]+)/);
        if (sizeMatch) textNode.fontSize = parseFloat(sizeMatch[1]);
      }

      return textNode;
    }

    // Container / DecoratedBox / Card — extract decoration
    if (
      widgetType === "Container" ||
      widgetType === "DecoratedBox" ||
      widgetType === "Card" ||
      widgetType === "Material"
    ) {
      const figma: FigmaNode = {
        type: "FRAME",
        name: widgetType,
        ...base,
        children,
      };

      // Source-extracted decoration from nearest user widget ancestor
      // (Inspector API often can't expose decoration internals; source has them.)
      const sourceDec = this.getAncestorDecoration();
      if (sourceDec?.gradient && !figma.fills) {
        figma.fills = [
          {
            type: "GRADIENT_LINEAR",
            gradientStops: sourceDec.gradient.colors.map((c, i) => ({
              color: c,
              position:
                sourceDec.gradient!.stops[i] ??
                i / Math.max(1, sourceDec.gradient!.colors.length - 1),
            })),
          },
        ];
      }
      if (sourceDec?.shadow && !figma.effects) {
        figma.effects = [
          {
            type: "DROP_SHADOW",
            color: sourceDec.shadow.color,
            offset: { x: sourceDec.shadow.offsetX, y: sourceDec.shadow.offsetY },
            radius: sourceDec.shadow.blurRadius,
            spread: sourceDec.shadow.spreadRadius,
          },
        ];
      }
      if (sourceDec?.border && !figma.strokes) {
        figma.strokes = [
          {
            type: "SOLID",
            color: {
              r: sourceDec.border.color.r,
              g: sourceDec.border.color.g,
              b: sourceDec.border.color.b,
            },
            opacity: sourceDec.border.color.a,
            weight: sourceDec.border.width,
          },
        ];
        figma.strokeWeight = sourceDec.border.width;
      }
      if (sourceDec?.borderRadius != null && figma.cornerRadius == null) {
        figma.cornerRadius = sourceDec.borderRadius;
      }

      for (const prop of props) {
        // Color
        const color = parseColor(prop.description);
        if (color && (prop.name === "color" || prop.name === "backgroundColor")) {
          figma.fills = [
            {
              type: "SOLID",
              color: { r: color.r, g: color.g, b: color.b },
              opacity: color.a,
            },
          ];
        }
        // Border radius
        const radius = parseBorderRadius(prop.description);
        if (radius != null) figma.cornerRadius = radius;
        // Padding
        const padding = parseEdgeInsets(prop.description);
        if (padding && prop.name === "padding") {
          figma.paddingLeft = padding.left;
          figma.paddingTop = padding.top;
          figma.paddingRight = padding.right;
          figma.paddingBottom = padding.bottom;
        }
        // LinearGradient (in decoration)
        if (
          (prop.name === "decoration" || prop.name === "gradient") &&
          prop.description.includes("LinearGradient")
        ) {
          const gradient = parseLinearGradient(prop.description);
          if (gradient) {
            figma.fills = [
              {
                type: "GRADIENT_LINEAR",
                gradientStops: gradient.colors.map((c, i) => ({
                  color: c,
                  position: gradient.stops[i] ?? i / Math.max(1, gradient.colors.length - 1),
                })),
              },
            ];
          }
        }
        // BoxShadow
        if (
          (prop.name === "decoration" || prop.name === "boxShadow") &&
          prop.description.includes("BoxShadow")
        ) {
          const shadow = parseBoxShadow(prop.description);
          if (shadow) {
            figma.effects = [
              {
                type: "DROP_SHADOW",
                color: shadow.color,
                offset: { x: shadow.offsetX, y: shadow.offsetY },
                radius: shadow.blurRadius,
                spread: shadow.spreadRadius,
              },
            ];
          }
        }
        // Border
        if (prop.name === "border" || prop.name === "decoration") {
          const border = parseBorder(prop.description);
          if (border) {
            figma.strokes = [
              {
                type: "SOLID",
                color: { r: border.color.r, g: border.color.g, b: border.color.b },
                opacity: border.color.a,
                weight: border.width,
              },
            ];
            figma.strokeWeight = border.width;
          }
        }
      }

      return figma;
    }

    // Image — try to extract asset path or network URL from properties
    if (widgetType === "Image") {
      const imageNode: FigmaNode = {
        type: "RECTANGLE",
        name: "Image",
        ...base,
      };
      // Look for AssetImage("path") or NetworkImage("url")
      for (const prop of props) {
        const asset = prop.description.match(/AssetImage\("([^"]+)"\)/);
        if (asset) {
          imageNode.imageAssetPath = asset[1];
          imageNode.name = `Image: ${asset[1].split("/").pop()}`;
          imageNode.fills = [{ type: "IMAGE", imageAssetPath: asset[1] }];
          break;
        }
        const network = prop.description.match(/NetworkImage\("([^"]+)"\)/);
        if (network) {
          imageNode.imageNetworkUrl = network[1];
          imageNode.name = `Image: (network)`;
          imageNode.fills = [{ type: "IMAGE", imageNetworkUrl: network[1] }];
          break;
        }
      }
      return imageNode;
    }

    // Icon — resolve codepoint to material icon name
    if (widgetType === "Icon") {
      const iconDataProp = props.find((p) =>
        p.description?.includes("IconData")
      );
      const codepointMatch = iconDataProp?.description.match(/U\+0?([0-9A-Fa-f]{4,5})/);
      const iconName = iconDataProp
        ? resolveIconName(iconDataProp.description)
        : null;
      const colorProp = props.find((p) => p.name === "color");
      const color = colorProp ? parseColor(colorProp.description) : null;

      const iconNode: FigmaNode = {
        type: "RECTANGLE",
        name: iconName ? `Icon: ${iconName}` : `Icon: ${node.name ?? ""}`,
        ...base,
        iconName: iconName ?? undefined,
        iconCodepoint: codepointMatch?.[1],
      };
      if (color) {
        iconNode.fills = [
          {
            type: "SOLID",
            color: { r: color.r, g: color.g, b: color.b },
            opacity: color.a,
          },
        ];
      }
      return iconNode;
    }

    // Scaffold, Column, Row, Stack, ListView etc. — structural containers
    if (
      widgetType === "Scaffold" ||
      widgetType === "Column" ||
      widgetType === "Row" ||
      widgetType === "Stack" ||
      widgetType === "Flex" ||
      widgetType === "ListView" ||
      widgetType === "SingleChildScrollView" ||
      widgetType === "CustomScrollView" ||
      widgetType === "SliverList" ||
      widgetType === "Padding" ||
      widgetType === "Center" ||
      widgetType === "Align" ||
      widgetType === "SizedBox" ||
      widgetType === "ConstrainedBox" ||
      widgetType === "Expanded" ||
      widgetType === "Flexible"
    ) {
      const figma: FigmaNode = {
        type: "FRAME",
        name: widgetType,
        ...base,
        children,
      };

      // Extract padding for Padding widget
      if (widgetType === "Padding") {
        const paddingProp = props.find((p) => p.name === "padding");
        if (paddingProp) {
          const padding = parseEdgeInsets(paddingProp.description);
          if (padding) {
            figma.paddingLeft = padding.left;
            figma.paddingTop = padding.top;
            figma.paddingRight = padding.right;
            figma.paddingBottom = padding.bottom;
          }
        }
      }

      return figma;
    }

    // ClipRRect — corner radius
    if (widgetType === "ClipRRect") {
      const figma: FigmaNode = {
        type: "FRAME",
        name: "ClipRRect",
        ...base,
        clipsContent: true,
        children,
      };
      const radiusProp = props.find((p) => p.name === "borderRadius");
      if (radiusProp) {
        const radius = parseBorderRadius(radiusProp.description);
        if (radius != null) figma.cornerRadius = radius;
      }
      return figma;
    }

    // If there are children, wrap in a frame
    if (children.length > 0) {
      return {
        type: "FRAME",
        name: widgetType || "Frame",
        ...base,
        children,
      };
    }

    // Leaf node with size — render as rectangle
    if (size.width > 0 && size.height > 0) {
      return {
        type: "RECTANGLE",
        name: widgetType || "Rectangle",
        ...base,
      };
    }

    return null;
  }
}
