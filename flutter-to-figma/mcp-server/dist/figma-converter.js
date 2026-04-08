/**
 * Converts Flutter Inspector DiagnosticsNode tree to Figma-compatible JSON.
 *
 * v2: Generic color extraction for ALL nodes + better Icon/Image/Divider support.
 *
 * Parses property descriptions (Color, EdgeInsets, BorderRadius, etc.)
 * from Flutter's debugFillProperties output, including nested decoration props.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
// ── Property parsers ──
/**
 * Parse color from Flutter property description.
 * Supports:
 *   "Color(0xffRRGGBB)"
 *   "Color(alpha: 1.0, red: 0.5, green: 0.5, blue: 0.5, colorSpace: ...)"
 */
export function parseColor(desc) {
    // New format: Color(alpha: A, red: R, green: G, blue: B, colorSpace: ...)
    const newMatch = desc.match(/Color\(.*?alpha:\s*([\d.]+).*?red:\s*([\d.]+).*?green:\s*([\d.]+).*?blue:\s*([\d.]+)/);
    if (newMatch) {
        return {
            a: parseFloat(newMatch[1]),
            r: parseFloat(newMatch[2]),
            g: parseFloat(newMatch[3]),
            b: parseFloat(newMatch[4]),
        };
    }
    // Legacy format: Color(0xAARRGGBB)
    const hexMatch = desc.match(/Color\(0x([0-9a-fA-F]{8})\)/);
    if (hexMatch) {
        const hex = hexMatch[1];
        return {
            a: parseInt(hex.substring(0, 2), 16) / 255,
            r: parseInt(hex.substring(2, 4), 16) / 255,
            g: parseInt(hex.substring(4, 6), 16) / 255,
            b: parseInt(hex.substring(6, 8), 16) / 255,
        };
    }
    return null;
}
/** Parse "EdgeInsets(L, T, R, B)" or "EdgeInsets.all(N)" etc. */
export function parseEdgeInsets(desc) {
    const allMatch = desc.match(/EdgeInsets\.all\(([0-9.]+)\)/);
    if (allMatch) {
        const v = parseFloat(allMatch[1]);
        return { left: v, top: v, right: v, bottom: v };
    }
    const ltrb = desc.match(/EdgeInsets\(([0-9.]+),\s*([0-9.]+),\s*([0-9.]+),\s*([0-9.]+)\)/);
    if (ltrb) {
        return {
            left: parseFloat(ltrb[1]),
            top: parseFloat(ltrb[2]),
            right: parseFloat(ltrb[3]),
            bottom: parseFloat(ltrb[4]),
        };
    }
    const sym = desc.match(/EdgeInsets\.symmetric\(.*?horizontal:\s*([0-9.]+).*?vertical:\s*([0-9.]+)/);
    if (sym) {
        const h = parseFloat(sym[1]);
        const v = parseFloat(sym[2]);
        return { left: h, top: v, right: h, bottom: v };
    }
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
export function parseBorderRadius(desc) {
    const circular = desc.match(/BorderRadius\.circular\(([0-9.]+)\)/);
    if (circular)
        return parseFloat(circular[1]);
    const all = desc.match(/Radius\.circular\(([0-9.]+)\)/);
    if (all)
        return parseFloat(all[1]);
    return null;
}
/** Parse font weight from "FontWeight.wNNN" or raw number */
export function parseFontWeight(desc) {
    const match = desc.match(/(?:FontWeight\.w)?(\d{3})/);
    if (match)
        return parseInt(match[1]);
    if (desc.includes("bold"))
        return 700;
    if (desc.includes("normal"))
        return 400;
    return null;
}
// ── Helpers ──
/** Parse asset path from AssetImage description */
export function parseAssetPath(desc) {
    const match = desc.match(/name:\s*"([^"]+)"/);
    return match ? match[1] : null;
}
/** Read an asset file and return base64 + mime type */
function readAssetAsBase64(projectRoot, assetPath) {
    const variants = [
        assetPath,
        assetPath.replace(/\/([^/]+)$/, "/3.0x/$1"),
        assetPath.replace(/\/([^/]+)$/, "/2.0x/$1"),
        assetPath.replace(/\/([^/]+)$/, "/1.5x/$1"),
    ];
    for (const variant of variants) {
        const fullPath = resolve(projectRoot, variant);
        if (existsSync(fullPath)) {
            try {
                const data = readFileSync(fullPath).toString("base64");
                const ext = fullPath.split(".").pop()?.toLowerCase() ?? "";
                const mimeMap = {
                    png: "image/png",
                    jpg: "image/jpeg",
                    jpeg: "image/jpeg",
                    gif: "image/gif",
                    webp: "image/webp",
                    svg: "image/svg+xml",
                };
                const mime = mimeMap[ext] ?? "image/png";
                console.error(`[flutter-to-figma] Loaded asset: ${variant} (${(data.length / 1024).toFixed(0)} KB base64)`);
                return { data, mime };
            }
            catch {
                // Continue to next variant
            }
        }
    }
    console.error(`[flutter-to-figma] Asset not found: ${assetPath} (tried in ${projectRoot})`);
    return null;
}
/**
 * Recursively flatten nested properties from getDetailsSubtree.
 * Flutter's diagnostic properties can be nested (e.g., decoration → color, borderRadius).
 */
function flattenProperties(props, depth = 0) {
    const result = [];
    if (!Array.isArray(props)) return result;
    for (const prop of props) {
        if (prop.name && prop.description) {
            result.push(prop);
        }
        // Recurse into sub-properties (e.g., BoxDecoration's children)
        if (depth < 3 && Array.isArray(prop.properties)) {
            result.push(...flattenProperties(prop.properties, depth + 1));
        }
    }
    return result;
}
/**
 * Extract visual properties (fills, cornerRadius, padding, opacity) from
 * a flat list of Flutter diagnostic properties. Applied to ALL nodes generically.
 */
function extractVisualProps(props) {
    const result = {};
    const flatProps = flattenProperties(props);
    for (const prop of flatProps) {
        const desc = prop.description ?? "";
        const name = prop.name ?? "";
        // Color / backgroundColor → fills
        if (!result.fills) {
            if (name === "color" || name === "backgroundColor" || name === "surfaceTintColor") {
                const color = parseColor(desc);
                if (color) {
                    result.fills = [
                        {
                            type: "SOLID",
                            color: { r: color.r, g: color.g, b: color.b },
                            opacity: color.a,
                        },
                    ];
                }
            }
        }
        // BorderRadius
        if (result.cornerRadius == null) {
            if (name === "borderRadius" || name === "radius") {
                const radius = parseBorderRadius(desc);
                if (radius != null) result.cornerRadius = radius;
            }
        }
        // Padding
        if (!result.padding) {
            if (name === "padding") {
                const padding = parseEdgeInsets(desc);
                if (padding) result.padding = padding;
            }
        }
        // Elevation (for Card / Material)
        if (result.elevation == null) {
            if (name === "elevation") {
                const elev = parseFloat(desc);
                if (!isNaN(elev) && elev > 0) result.elevation = elev;
            }
        }
    }
    return result;
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
    "AbsorbPointer",
    "IgnorePointer",
    "MetaData",
    "Offstage",
    "TickerMode",
]);
export class FigmaConverter {
    projectRoot;
    constructor(inspector, projectRoot) {
        this.inspector = inspector;
        this.projectRoot = projectRoot ?? process.cwd();
    }
    inspector;
    /** Convert the full Flutter widget tree to Figma JSON */
    async convert() {
        const rootTree = await this.inspector.getRootTree();
        const children = await this.convertChildren(rootTree.children ?? []);
        let maxW = 0;
        let maxH = 0;
        for (const child of children) {
            maxW = Math.max(maxW, child.x + child.width);
            maxH = Math.max(maxH, child.y + child.height);
        }
        return {
            metadata: {
                exportDate: new Date().toISOString(),
                method: "inspector_api_v3",
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
    async convertChildren(nodes) {
        const results = [];
        for (const node of nodes) {
            const converted = await this.convertNode(node);
            results.push(...converted);
        }
        return results;
    }
    async convertNode(node) {
        const widgetType = node.widgetRuntimeType ?? node.description?.split("(")[0]?.trim() ?? "";
        // Skip non-visual widgets — pass children through
        if (TRANSPARENT_WIDGETS.has(widgetType)) {
            return this.convertChildren(node.children ?? []);
        }
        // Get detailed info
        let props = [];
        let layoutSize = { width: 0, height: 0 };
        let layoutOffset = { offsetX: 0, offsetY: 0 };
        const nodeId = node.valueId;
        if (nodeId) {
            try {
                const details = await this.inspector.getDetailsSubtree(nodeId, 2);
                props = details?.properties ?? [];
            }
            catch (err) {
                console.error(`[flutter-to-figma] getDetailsSubtree failed for ${widgetType} (${nodeId}):`, err instanceof Error ? err.message : err);
            }
            try {
                const layout = await this.inspector.getLayoutExplorerNode(nodeId);
                if (layout?.size) {
                    layoutSize = {
                        width: parseFloat(layout.size.width) || 0,
                        height: parseFloat(layout.size.height) || 0,
                    };
                }
                if (layout?.parentData) {
                    layoutOffset = {
                        offsetX: layout.parentData.offsetX ?? 0,
                        offsetY: layout.parentData.offsetY ?? 0,
                    };
                }
            }
            catch (err) {
                console.error(`[flutter-to-figma] getLayoutExplorerNode failed for ${widgetType} (${nodeId}):`, err instanceof Error ? err.message : err);
            }
        }
        else {
            console.error(`[flutter-to-figma] No valueId for node: ${widgetType} (description: ${node.description})`);
        }
        const children = await this.convertChildren(node.children ?? []);
        const figmaNode = await this.buildFigmaNode(widgetType, node, props, layoutSize, layoutOffset, children, nodeId);
        if (figmaNode)
            return [figmaNode];
        return children;
    }
    async buildFigmaNode(widgetType, node, props, size, offset, children, nodeId) {
        const base = {
            x: offset.offsetX,
            y: offset.offsetY,
            width: size.width,
            height: size.height,
        };
        // ── Text ──
        if (widgetType === "Text" || widgetType === "RichText") {
            return this.buildTextNode(node, props, base);
        }
        // ── Image ──
        if (widgetType === "Image") {
            return await this.buildImageNode(node, props, base, nodeId);
        }
        // ── Icon ──
        if (widgetType === "Icon") {
            return await this.buildIconNode(node, props, base, nodeId);
        }
        // ── Divider ──
        if (widgetType === "Divider" || widgetType === "VerticalDivider") {
            return this.buildDividerNode(widgetType, props, base);
        }
        // ── ClipRRect ──
        if (widgetType === "ClipRRect") {
            const figma = {
                type: "FRAME",
                name: "ClipRRect",
                ...base,
                clipsContent: true,
                children,
            };
            this.applyVisualProps(figma, props);
            return figma;
        }
        // ── All other widgets → FRAME with generic visual extraction ──
        if (children.length > 0 || size.width > 0) {
            const figma = {
                type: "FRAME",
                name: widgetType || "Frame",
                ...base,
                children,
            };
            this.applyVisualProps(figma, props);
            return figma;
        }
        // Leaf node with size
        if (size.width > 0 && size.height > 0) {
            const figma = {
                type: "RECTANGLE",
                name: widgetType || "Rectangle",
                ...base,
            };
            this.applyVisualProps(figma, props);
            return figma;
        }
        return null;
    }
    /** Apply extracted visual properties to any Figma node */
    applyVisualProps(figma, props) {
        const visual = extractVisualProps(props);
        if (visual.fills) figma.fills = visual.fills;
        if (visual.cornerRadius != null) figma.cornerRadius = visual.cornerRadius;
        if (visual.padding) {
            figma.paddingLeft = visual.padding.left;
            figma.paddingTop = visual.padding.top;
            figma.paddingRight = visual.padding.right;
            figma.paddingBottom = visual.padding.bottom;
        }
        if (visual.elevation != null) {
            figma.effects = [
                {
                    type: "DROP_SHADOW",
                    color: { r: 0, g: 0, b: 0, a: 0.15 },
                    offset: { x: 0, y: visual.elevation },
                    radius: visual.elevation * 2,
                },
            ];
        }
    }
    buildTextNode(node, props, base) {
        const flatProps = flattenProperties(props);
        const dataProp = flatProps.find((p) => p.name === "data");
        let text = dataProp?.description ?? "";
        if (!text && node.description) {
            const match = node.description.match(/^(?:Text|RichText)\("(.*)"\)$/s);
            if (match)
                text = match[1];
        }
        if (!text)
            text = node.name ?? "";
        if (text.startsWith('"') && text.endsWith('"')) {
            text = text.slice(1, -1);
        }
        const textNode = {
            type: "TEXT",
            name: `Text: ${text.substring(0, 30)}`,
            ...base,
            characters: text,
        };
        // Extract text style from all properties (including nested)
        const colorProp = flatProps.find((p) => p.name === "color");
        if (colorProp?.description) {
            const color = parseColor(colorProp.description);
            if (color) {
                textNode.fills = [
                    {
                        type: "SOLID",
                        color: { r: color.r, g: color.g, b: color.b },
                        opacity: color.a,
                    },
                ];
            }
        }
        const weightProp = flatProps.find((p) => p.name === "weight" || p.name === "fontWeight");
        if (weightProp?.description) {
            const weight = parseFontWeight(weightProp.description);
            if (weight)
                textNode.fontWeight = weight;
        }
        const sizeProp = flatProps.find((p) => p.name === "size" || p.name === "fontSize");
        if (sizeProp?.description) {
            const fontSize = parseFloat(sizeProp.description);
            if (!isNaN(fontSize))
                textNode.fontSize = fontSize;
        }
        const familyProp = flatProps.find((p) => p.name === "family" || p.name === "fontFamily");
        if (familyProp?.description && familyProp.description !== "null") {
            textNode.fontFamily = familyProp.description;
        }
        return textNode;
    }
    async buildImageNode(node, props, base, nodeId) {
        const flatProps = flattenProperties(props);
        const imageProp = flatProps.find((p) => p.name === "image");
        let assetPath = null;
        let isNetworkImage = false;
        if (imageProp?.description) {
            assetPath = parseAssetPath(imageProp.description);
            isNetworkImage = imageProp.description.includes("NetworkImage") ||
                imageProp.description.includes("CachedNetworkImage");
        }
        const figma = {
            type: "RECTANGLE",
            name: assetPath ? `Image: ${assetPath.split("/").pop()}` : (isNetworkImage ? "Image: (network)" : "Image"),
            ...base,
        };
        // Try local asset first
        if (assetPath) {
            const asset = readAssetAsBase64(this.projectRoot, assetPath);
            if (asset) {
                figma.fills = [
                    {
                        type: "IMAGE",
                        imageData: asset.data,
                        imageMimeType: asset.mime,
                        scaleMode: "FIT",
                    },
                ];
                figma.imageData = asset.data;
                figma.imageMimeType = asset.mime;
                return figma;
            }
        }
        // Fallback: try screenshot for network images or missing assets
        if (nodeId && (isNetworkImage || !assetPath)) {
            try {
                const screenshot = await this.inspector.screenshot(nodeId, Math.round(base.width) || 100, Math.round(base.height) || 100);
                if (screenshot) {
                    figma.fills = [
                        {
                            type: "IMAGE",
                            imageData: screenshot,
                            imageMimeType: "image/png",
                            scaleMode: "FIT",
                        },
                    ];
                    figma.imageData = screenshot;
                    figma.imageMimeType = "image/png";
                    console.error(`[flutter-to-figma] Captured screenshot for ${figma.name}`);
                }
            }
            catch (err) {
                console.error(`[flutter-to-figma] Screenshot fallback failed for Image:`, err instanceof Error ? err.message : err);
            }
        }
        return figma;
    }
    async buildIconNode(node, props, base, nodeId) {
        const flatProps = flattenProperties(props);
        // Extract icon info
        const iconProp = flatProps.find((p) => p.name === "icon");
        const iconName = iconProp?.description ?? node.name ?? "icon";
        const figma = {
            type: "RECTANGLE",
            name: `Icon: ${iconName.substring(0, 40)}`,
            ...base,
        };
        // Extract color
        const colorProp = flatProps.find((p) => p.name === "color");
        if (colorProp?.description) {
            const color = parseColor(colorProp.description);
            if (color) {
                figma.fills = [
                    {
                        type: "SOLID",
                        color: { r: color.r, g: color.g, b: color.b },
                        opacity: color.a,
                    },
                ];
            }
        }
        // Try screenshot to capture the actual icon glyph
        if (nodeId) {
            try {
                const screenshot = await this.inspector.screenshot(nodeId, Math.round(base.width) || 24, Math.round(base.height) || 24);
                if (screenshot) {
                    figma.fills = [
                        {
                            type: "IMAGE",
                            imageData: screenshot,
                            imageMimeType: "image/png",
                            scaleMode: "FIT",
                        },
                    ];
                    figma.imageData = screenshot;
                    figma.imageMimeType = "image/png";
                    console.error(`[flutter-to-figma] Captured screenshot for Icon: ${iconName}`);
                }
            }
            catch (err) {
                console.error(`[flutter-to-figma] Screenshot fallback failed for Icon:`, err instanceof Error ? err.message : err);
            }
        }
        return figma;
    }
    buildDividerNode(widgetType, props, base) {
        const flatProps = flattenProperties(props);
        const figma = {
            type: "RECTANGLE",
            name: widgetType,
            ...base,
        };
        // Divider default: thin gray line
        let color = null;
        const colorProp = flatProps.find((p) => p.name === "color");
        if (colorProp?.description) {
            color = parseColor(colorProp.description);
        }
        figma.fills = [
            {
                type: "SOLID",
                color: color
                    ? { r: color.r, g: color.g, b: color.b }
                    : { r: 0.85, g: 0.85, b: 0.85 },
                opacity: color?.a ?? 1,
            },
        ];
        // Ensure minimum visible height for horizontal divider
        if (widgetType === "Divider" && figma.height < 1) {
            figma.height = 1;
        }
        if (widgetType === "VerticalDivider" && figma.width < 1) {
            figma.width = 1;
        }
        return figma;
    }
}

// ── Theme token extraction (used by extract_theme tool) ──
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function collectDartFilesForTheme(root) {
    const files = [];
    const walk = (d) => {
        try {
            for (const entry of readdirSync(d)) {
                if (entry.startsWith(".")) continue;
                const full = join(d, entry);
                const st = statSync(full);
                if (st.isDirectory()) {
                    if (entry === "build" || entry === ".dart_tool" || entry === "node_modules") continue;
                    walk(full);
                } else if (entry.endsWith(".dart") && !entry.endsWith(".g.dart") && !entry.endsWith(".freezed.dart")) {
                    files.push(full);
                }
            }
        } catch { /* skip */ }
    };
    walk(root);
    return files;
}

function addColorToken(colors, name, hex) {
    if (colors[name]) return;
    colors[name] = {
        a: parseInt(hex.substring(0, 2), 16) / 255,
        r: parseInt(hex.substring(2, 4), 16) / 255,
        g: parseInt(hex.substring(4, 6), 16) / 255,
        b: parseInt(hex.substring(6, 8), 16) / 255,
    };
}

function extractClassBodyFromContent(content, startIdx) {
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

export function extractThemeTokens(projectRoot) {
    const tokens = { spacing: {}, radius: {}, colors: {} };
    const libDir = join(projectRoot, "lib");
    if (!existsSync(libDir)) return tokens;

    const dartFiles = collectDartFilesForTheme(libDir);

    for (const file of dartFiles) {
        let content;
        try {
            content = readFileSync(file, "utf-8");
        } catch { continue; }

        const colorMatches1 = content.matchAll(/(\w+):\s*Color\(0x([0-9A-Fa-f]{8})\)/g);
        for (const m of colorMatches1) addColorToken(tokens.colors, m[1], m[2]);
        const colorMatches2 = content.matchAll(/(?:static\s+const|final|const)\s+Color\s+(\w+)\s*=\s*Color\(0x([0-9A-Fa-f]{8})\)/g);
        for (const m of colorMatches2) addColorToken(tokens.colors, m[1], m[2]);
        const colorMatches3 = content.matchAll(/Color\s+get\s+(\w+)\s*=>\s*(?:const\s+)?Color\(0x([0-9A-Fa-f]{8})\)/g);
        for (const m of colorMatches3) addColorToken(tokens.colors, m[1], m[2]);

        const classMatches = [...content.matchAll(/class\s+(\w+)(?:\s+extends[^{]*)?\s*\{/g)];
        for (const classMatch of classMatches) {
            const className = classMatch[1];
            const classBody = extractClassBodyFromContent(content, classMatch.index ?? 0);
            if (!classBody) continue;

            const isRadiusClass = /Radius|Corner/i.test(className);
            const isSpacingClass = /Spacing|Padding|Margin|Gap|Sizing|Size|Dimension/i.test(className);

            const numericMatches = [
                ...classBody.matchAll(/(\w+):\s*([0-9.]+)\.[whrsp]+,/g),
                ...classBody.matchAll(/(?:static\s+const|final|const)\s+(?:double|int)\s+(\w+)\s*=\s*([0-9.]+)/g),
                ...classBody.matchAll(/(?:double|int)\s+get\s+(\w+)\s*=>\s*([0-9.]+)(?:\.[whrsp]+)?/g),
            ];
            for (const m of numericMatches) {
                const name = m[1];
                const value = parseFloat(m[2]);
                if (isRadiusClass) tokens.radius[name] = value;
                else if (isSpacingClass) tokens.spacing[name] = value;
                else if (/radius|corner/i.test(name)) tokens.radius[name] = value;
                else tokens.spacing[name] = value;
            }
        }
    }
    return tokens;
}
