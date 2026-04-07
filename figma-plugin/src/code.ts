import { createNode, getNodeCount, resetNodeCount } from './node_creator';

figma.showUI(__html__, { width: 480, height: 520 });

figma.ui.onmessage = async (msg: { type: string; data?: any }) => {
  if (msg.type === 'import' && msg.data) {
    try {
      resetNodeCount();

      // Create the main node tree.
      var rootNode = await createNode(msg.data.root);

      // If a screenshot is provided, create an overlay reference.
      var screenshot = msg.data.metadata && msg.data.metadata.screenshot;
      if (screenshot) {
        // Create a group with screenshot overlay + structure.
        var group = figma.createFrame();
        group.name = 'Flutter Export';
        group.resize(
          msg.data.root.width || rootNode.width,
          msg.data.root.height || rootNode.height,
        );
        group.fills = [];

        // Screenshot as background reference.
        var screenshotRect = figma.createRectangle();
        screenshotRect.name = 'Screenshot (Reference)';
        screenshotRect.resize(group.width, group.height);
        screenshotRect.opacity = 0.5;

        // Decode Base64 and create image.
        var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        var bufferLength = Math.floor(screenshot.length * 0.75);
        if (screenshot[screenshot.length - 1] === '=') bufferLength--;
        if (screenshot[screenshot.length - 2] === '=') bufferLength--;
        var bytes = new Uint8Array(bufferLength);
        var p = 0;
        for (var i = 0; i < screenshot.length; i += 4) {
          var a = chars.indexOf(screenshot[i]);
          var b = chars.indexOf(screenshot[i + 1]);
          var c = chars.indexOf(screenshot[i + 2]);
          var d = chars.indexOf(screenshot[i + 3]);
          bytes[p++] = (a << 2) | (b >> 4);
          if (c !== -1 && screenshot[i + 2] !== '=') bytes[p++] = ((b & 15) << 4) | (c >> 2);
          if (d !== -1 && screenshot[i + 3] !== '=') bytes[p++] = ((c & 3) << 6) | d;
        }
        var image = figma.createImage(bytes);
        screenshotRect.fills = [{
          type: 'IMAGE',
          imageHash: image.hash,
          scaleMode: 'FILL',
        } as ImagePaint];

        group.appendChild(screenshotRect);
        group.appendChild(rootNode);

        figma.currentPage.appendChild(group);
        figma.viewport.scrollAndZoomIntoView([group]);
      } else {
        figma.currentPage.appendChild(rootNode);
        figma.viewport.scrollAndZoomIntoView([rootNode]);
      }

      figma.ui.postMessage({
        type: 'done',
        nodeCount: getNodeCount(),
      });
    } catch (e: any) {
      figma.ui.postMessage({
        type: 'error',
        message: e.message || String(e),
      });
    }
  }
};
