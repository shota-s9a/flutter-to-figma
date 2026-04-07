/**
 * Converts Flutter Inspector DiagnosticsNode tree to Figma-compatible JSON.
 *
 * Parses property descriptions (Color, EdgeInsets, BorderRadius, etc.)
 * from Flutter's debugFillProperties output.
 */
import { FlutterInspector } from "./inspector.js";
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
    characters?: string;
    fontSize?: number;
    fontFamily?: string;
    fontWeight?: number;
    textAlignHorizontal?: string;
    lineHeight?: number;
}
interface FigmaFill {
    type: "SOLID";
    color: {
        r: number;
        g: number;
        b: number;
    };
    opacity?: number;
}
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
export declare class FigmaConverter {
    private inspector;
    constructor(inspector: FlutterInspector);
    /** Convert the full Flutter widget tree to Figma JSON */
    convert(): Promise<{
        metadata: Record<string, unknown>;
        root: FigmaNode;
    }>;
    private convertChildren;
    private convertNode;
    private buildFigmaNode;
}
export {};
