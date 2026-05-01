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

  /**
   * Get the full widget tree from the root.
   *
   * Two-step: getRootWidget → getDetailsSubtree(rootValueId, depth=10000).
   * `getRootWidgetSummaryTreeWithPreviews` cannot be used because on
   * Flutter 3.27+ the summary-tree valueIds return `{}` from
   * getLayoutExplorerNode, so every node ends up with size 0x0.
   */
  async getRootTree(): Promise<DiagNode> {
    const rootResult = await this.client.callServiceExtension(
      "ext.flutter.inspector.getRootWidget",
      this.isolateId,
      {
        objectGroup: "figma-export",
      }
    );
    const root = rootResult.result as unknown as DiagNode | undefined;
    if (!root?.valueId) return root as DiagNode;

    const detailsResult = await this.client.callServiceExtension(
      "ext.flutter.inspector.getDetailsSubtree",
      this.isolateId,
      {
        arg: root.valueId,
        objectGroup: "figma-export",
        subtreeDepth: "10000",
      }
    );
    return detailsResult.result as unknown as DiagNode;
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

  /**
   * Get layout info (size, constraints, offset) for a node.
   * Note: this extension expects `id`/`groupName`, NOT `arg`/`objectGroup`
   * (which is what getDetailsSubtree/getProperties use). Passing the wrong
   * names silently returns an empty map, leaving every node with size 0x0.
   */
  async getLayoutExplorerNode(objectId: string): Promise<DiagNode> {
    const result = await this.client.callServiceExtension(
      "ext.flutter.inspector.getLayoutExplorerNode",
      this.isolateId,
      {
        id: objectId,
        groupName: "figma-export",
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

  /**
   * Find all nodes in the tree whose widget type or runtimeType matches `name`.
   * Returns nodes with their objectId/valueId so callers can screenshot or inspect them.
   */
  async findNodesByName(name: string): Promise<DiagNode[]> {
    const root = await this.getRootTree();
    const matches: DiagNode[] = [];
    const walk = (node: DiagNode) => {
      const widgetType = node.description?.split("(")[0]?.trim() ?? "";
      if (widgetType === name || node.name === name) {
        matches.push(node);
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(root);
    return matches;
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
