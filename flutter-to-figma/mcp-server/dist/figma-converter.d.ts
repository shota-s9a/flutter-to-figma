/**
 * Converts Flutter Inspector DiagnosticsNode tree to Figma-compatible JSON.
 *
 * Parses property descriptions (Color, EdgeInsets, BorderRadius, etc.)
 * from Flutter's debugFillProperties output.
 */
import { FlutterInspector } from "./inspector.js";
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
    backgroundColor?: {
        r: number;
        g: number;
        b: number;
        a: number;
    };
}
/** Resolved theme tokens from Dart source (used to substitute context.spacing.md etc.) */
export interface ThemeTokens {
    spacing: Record<string, number>;
    radius: Record<string, number>;
    colors: Record<string, {
        r: number;
        g: number;
        b: number;
        a: number;
    }>;
}
/**
 * Walk all .dart files under `projectRoot/lib` and extract per-class decoration info.
 * Looks for any `class XXX extends *Widget` block (generic, matches any
 * custom widget base class: StatelessWidget, ConsumerStatefulWidget, etc.)
 * and finds BoxDecoration / LinearGradient / BoxShadow within them.
 */
export declare function extractDecorationsFromProject(projectRoot: string, themeTokens?: ThemeTokens): Map<string, WidgetDecoration>;
/**
 * Extract theme tokens from any Dart source files under `lib/`.
 * Scans the whole lib tree (not just theme dirs) and picks up:
 *   - Color constants: `name: Color(0xAARRGGBB)` / `static const Color name = Color(...)` / `final Color name = Color(...)`
 *   - Numeric tokens: `name: N.w/h/r/sp,` (ScreenUtil) / `static const double name = N;`
 * Classifies numeric tokens into `spacing` vs `radius` based on class context
 * (class name contains "Radius" / "Corner" → radius, else → spacing).
 * Returns tokens by name; the resolver uses the last dot segment.
 */
export declare function extractThemeTokens(projectRoot: string): ThemeTokens;
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
    characters?: string;
    fontSize?: number;
    fontFamily?: string;
    fontWeight?: number;
    textAlignHorizontal?: string;
    lineHeight?: number;
    imageAssetPath?: string;
    imageNetworkUrl?: string;
    iconName?: string;
    iconCodepoint?: string;
}
type FigmaFill = {
    type: "SOLID";
    color: {
        r: number;
        g: number;
        b: number;
    };
    opacity?: number;
} | {
    type: "GRADIENT_LINEAR";
    gradientStops: {
        color: {
            r: number;
            g: number;
            b: number;
            a: number;
        };
        position: number;
    }[];
    gradientHandlePositions?: {
        x: number;
        y: number;
    }[];
} | {
    type: "IMAGE";
    imageAssetPath?: string;
    imageNetworkUrl?: string;
};
interface FigmaStroke {
    type: "SOLID";
    color: {
        r: number;
        g: number;
        b: number;
    };
    opacity?: number;
    weight?: number;
}
interface FigmaEffect {
    type: "DROP_SHADOW";
    color: {
        r: number;
        g: number;
        b: number;
        a: number;
    };
    offset: {
        x: number;
        y: number;
    };
    radius: number;
    spread?: number;
}
/** Parse "Color(0xffRRGGBB)" or "Color(0xAARRGGBB)" */
export declare function parseColor(desc: string): {
    r: number;
    g: number;
    b: number;
    a: number;
} | null;
/** Parse "EdgeInsets(L, T, R, B)" or "EdgeInsets.all(N)" etc. */
export declare function parseEdgeInsets(desc: string): {
    left: number;
    top: number;
    right: number;
    bottom: number;
} | null;
/** Parse "BorderRadius.circular(N)" or "BorderRadius.all(Radius.circular(N))" */
export declare function parseBorderRadius(desc: string): number | null;
/** Parse font weight from "FontWeight.wNNN" */
export declare function parseFontWeight(desc: string): number | null;
/** Parse "LinearGradient(...)" to a Figma GRADIENT_LINEAR fill */
export interface ParsedGradient {
    type: "GRADIENT_LINEAR";
    colors: {
        r: number;
        g: number;
        b: number;
        a: number;
    }[];
    stops: number[];
    beginAlignment: string;
    endAlignment: string;
}
export declare function parseLinearGradient(desc: string): ParsedGradient | null;
/** Parse "BoxShadow(...)" — first shadow only */
export interface ParsedShadow {
    color: {
        r: number;
        g: number;
        b: number;
        a: number;
    };
    offsetX: number;
    offsetY: number;
    blurRadius: number;
    spreadRadius: number;
}
export declare function parseBoxShadow(desc: string): ParsedShadow | null;
/** Parse "Border.all(color: ..., width: N)" or "BorderSide(...)" */
export interface ParsedBorder {
    color: {
        r: number;
        g: number;
        b: number;
        a: number;
    };
    width: number;
}
export declare function parseBorder(desc: string): ParsedBorder | null;
export declare function resolveIconName(iconDataDesc: string): string | null;
export declare class FigmaConverter {
    private inspector;
    private decorations;
    private themeTokens;
    /**
     * Stack of ancestor widget class names so leaf nodes (Container/DecoratedBox)
     * can match the closest parent widget that has a known decoration in source.
     */
    private ancestorStack;
    constructor(inspector: FlutterInspector, options?: {
        projectRoot?: string;
    });
    /** Convert the full Flutter widget tree to Figma JSON */
    convert(): Promise<{
        metadata: Record<string, unknown>;
        root: FigmaNode;
    }>;
    private convertChildren;
    private convertNode;
    /** Get the nearest ancestor's decoration from the source-extracted map */
    private getAncestorDecoration;
    private buildFigmaNode;
}
export {};
