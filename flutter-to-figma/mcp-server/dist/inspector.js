/**
 * Flutter Inspector API wrapper — extracts Widget/RenderObject tree
 * using built-in ext.flutter.inspector.* extensions.
 */
export class FlutterInspector {
    client;
    isolateId;
    constructor(client, isolateId) {
        this.client = client;
        this.isolateId = isolateId;
    }
    /**
     * Get the full widget tree from the root.
     *
     * Two-step: getRootWidget → getDetailsSubtree(rootValueId, depth=10000).
     * `getRootWidgetSummaryTreeWithPreviews` cannot be used because on
     * Flutter 3.27+ the summary-tree valueIds return `{}` from
     * getLayoutExplorerNode, so every node ends up with size 0x0.
     */
    async getRootTree() {
        const rootResult = await this.client.callServiceExtension("ext.flutter.inspector.getRootWidget", this.isolateId, {
            objectGroup: "figma-export",
        });
        const root = rootResult.result;
        if (!root?.valueId)
            return root;
        const detailsResult = await this.client.callServiceExtension("ext.flutter.inspector.getDetailsSubtree", this.isolateId, {
            arg: root.valueId,
            objectGroup: "figma-export",
            subtreeDepth: "10000",
        });
        return detailsResult.result;
    }
    /** Get detailed subtree for a specific node (with properties) */
    async getDetailsSubtree(objectId, subtreeDepth = 2) {
        const result = await this.client.callServiceExtension("ext.flutter.inspector.getDetailsSubtree", this.isolateId, {
            arg: objectId,
            objectGroup: "figma-export",
            subtreeDepth: String(subtreeDepth),
        });
        return result.result;
    }
    /**
     * Get layout info (size, constraints, offset) for a node.
     * Note: this extension expects `id`/`groupName`, NOT `arg`/`objectGroup`
     * (which is what getDetailsSubtree/getProperties use). Passing the wrong
     * names silently returns an empty map, leaving every node with size 0x0.
     */
    async getLayoutExplorerNode(objectId) {
        const result = await this.client.callServiceExtension("ext.flutter.inspector.getLayoutExplorerNode", this.isolateId, {
            id: objectId,
            groupName: "figma-export",
            subtreeDepth: "1",
        });
        return result.result;
    }
    /** Get properties of a node */
    async getProperties(objectId) {
        const result = await this.client.callServiceExtension("ext.flutter.inspector.getProperties", this.isolateId, {
            arg: objectId,
            objectGroup: "figma-export",
        });
        return result.result ?? [];
    }
    /** Take a screenshot of a RenderObject */
    async screenshot(renderObjectId, width, height) {
        try {
            const result = await this.client.callServiceExtension("ext.flutter.inspector.screenshot", this.isolateId, {
                id: renderObjectId,
                width: String(width),
                height: String(height),
            });
            return result.result?.image ?? null;
        }
        catch {
            return null;
        }
    }
    /**
     * Find all nodes in the tree whose widget type or runtimeType matches `name`.
     * Returns nodes with their objectId/valueId so callers can screenshot or inspect them.
     */
    async findNodesByName(name) {
        const root = await this.getRootTree();
        const matches = [];
        const walk = (node) => {
            const widgetType = node.description?.split("(")[0]?.trim() ?? "";
            if (widgetType === name || node.name === name) {
                matches.push(node);
            }
            for (const child of node.children ?? [])
                walk(child);
        };
        walk(root);
        return matches;
    }
    /** Evaluate a Dart expression against an object (for Color RGBA etc.) */
    async evaluateOn(targetId, expression) {
        try {
            const result = await this.client.evaluate(this.isolateId, targetId, expression);
            return result.valueAsString ?? null;
        }
        catch {
            return null;
        }
    }
}
