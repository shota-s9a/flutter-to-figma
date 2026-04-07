/**
 * Converts Flutter Inspector DiagnosticsNode tree to Figma-compatible JSON.
 *
 * Parses property descriptions (Color, EdgeInsets, BorderRadius, etc.)
 * from Flutter's debugFillProperties output.
 */

import { DiagNode, DiagProperty, FlutterInspector } from "./inspector.js";

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
  cornerRadius?: number;
  clipsContent?: boolean;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  children?: FigmaNode[];
  // TEXT
  characters?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: number;
  textAlignHorizontal?: string;
  lineHeight?: number;
}

interface FigmaFill {
  type: "SOLID";
  color: { r: number; g: number; b: number };
  opacity?: number;
}

interface FigmaStroke {
  type: "SOLID";
  color: { r: number; g: number; b: number };
  opacity?: number;
  weight?: number;
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
  constructor(private inspector: FlutterInspector) {}

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

    if (figmaNode) return [figmaNode];

    // If we couldn't create a node, pass children through
    return children;
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
      }

      return figma;
    }

    // Image
    if (widgetType === "Image") {
      return {
        type: "RECTANGLE",
        name: "Image",
        ...base,
      };
    }

    // Icon
    if (widgetType === "Icon") {
      return {
        type: "RECTANGLE",
        name: `Icon: ${node.name ?? ""}`,
        ...base,
      };
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
