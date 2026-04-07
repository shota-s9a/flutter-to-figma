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
  // Layout info from getLayoutExplorerNode
  size?: { width: number; height: number };
  constraints?: Record<string, number>;
  parentData?: { offsetX: number; offsetY: number };
  renderObject?: DiagNode;
}

export interface DiagProperty {
  name: string;
  description: string;
  propertyType: string;
  value?: unknown;
  type: string;
}

export class FlutterInspector {
  constructor(
    private client: VmServiceClient,
    private isolateId: string
  ) {}

  /** Get the full widget summary tree from the root */
  async getRootTree(): Promise<DiagNode> {
    const result = await this.client.callServiceExtension(
      "ext.flutter.inspector.getRootWidgetSummaryTreeWithPreviews",
      this.isolateId
    );
    return result.result as unknown as DiagNode;
  }

  /** Get detailed subtree for a specific node (with properties) */
  async getDetailsSubtree(
    objectId: string,
    subtreeDepth: number = 2
  ): Promise<DiagNode> {
    const result = await this.client.callServiceExtension(
      "ext.flutter.inspector.getDetailsSubtree",
      this.isolateId,
      {
        arg: objectId,
        objectGroup: "figma-export",
        subtreeDepth: String(subtreeDepth),
      }
    );
    return result.result as unknown as DiagNode;
  }

  /** Get layout info (size, constraints, offset) for a node */
  async getLayoutExplorerNode(objectId: string): Promise<DiagNode> {
    const result = await this.client.callServiceExtension(
      "ext.flutter.inspector.getLayoutExplorerNode",
      this.isolateId,
      {
        arg: objectId,
        objectGroup: "figma-export",
        subtreeDepth: "1",
      }
    );
    return result.result as unknown as DiagNode;
  }

  /** Get properties of a node */
  async getProperties(objectId: string): Promise<DiagProperty[]> {
    const result = await this.client.callServiceExtension(
      "ext.flutter.inspector.getProperties",
      this.isolateId,
      {
        arg: objectId,
        objectGroup: "figma-export",
      }
    );
    return (result.result as unknown as DiagProperty[]) ?? [];
  }

  /** Take a screenshot of a RenderObject */
  async screenshot(
    renderObjectId: string,
    width: number,
    height: number
  ): Promise<string | null> {
    try {
      const result = await this.client.callServiceExtension(
        "ext.flutter.inspector.screenshot",
        this.isolateId,
        {
          id: renderObjectId,
          width: String(width),
          height: String(height),
        }
      );
      return (result.result as { image?: string })?.image ?? null;
    } catch {
      return null;
    }
  }

  /** Evaluate a Dart expression against an object (for Color RGBA etc.) */
  async evaluateOn(
    targetId: string,
    expression: string
  ): Promise<string | null> {
    try {
      const result = await this.client.evaluate(
        this.isolateId,
        targetId,
        expression
      );
      return (result as { valueAsString?: string }).valueAsString ?? null;
    } catch {
      return null;
    }
  }
}
