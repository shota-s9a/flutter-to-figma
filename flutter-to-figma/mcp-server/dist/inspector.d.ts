/**
 * Flutter Inspector API wrapper — extracts Widget/RenderObject tree
 * using built-in ext.flutter.inspector.* extensions.
 */
import { VmServiceClient } from "./vm-service.js";
/** Diagnostics node from Flutter Inspector */
export interface DiagNode {
    description: string;
    type: string;
    name?: string;
    valueId?: string;
    objectId?: string;
    children?: DiagNode[];
    properties?: DiagProperty[];
    size?: {
        width: number;
        height: number;
    };
    constraints?: Record<string, number>;
    parentData?: {
        offsetX: number;
        offsetY: number;
    };
    renderObject?: DiagNode;
}
export interface DiagProperty {
    name: string;
    description: string;
    propertyType: string;
    value?: unknown;
    type: string;
}
export declare class FlutterInspector {
    private client;
    private isolateId;
    constructor(client: VmServiceClient, isolateId: string);
    /** Get the full widget summary tree from the root */
    getRootTree(): Promise<DiagNode>;
    /** Get detailed subtree for a specific node (with properties) */
    getDetailsSubtree(objectId: string, subtreeDepth?: number): Promise<DiagNode>;
    /** Get layout info (size, constraints, offset) for a node */
    getLayoutExplorerNode(objectId: string): Promise<DiagNode>;
    /** Get properties of a node */
    getProperties(objectId: string): Promise<DiagProperty[]>;
    /** Take a screenshot of a RenderObject */
    screenshot(renderObjectId: string, width: number, height: number): Promise<string | null>;
    /**
     * Find all nodes in the tree whose widget type or runtimeType matches `name`.
     * Returns nodes with their objectId/valueId so callers can screenshot or inspect them.
     */
    findNodesByName(name: string): Promise<DiagNode[]>;
    /** Evaluate a Dart expression against an object (for Color RGBA etc.) */
    evaluateOn(targetId: string, expression: string): Promise<string | null>;
}
