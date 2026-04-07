"use strict";
(() => {
  // src/node_creator.ts
  var FONT_WEIGHT_MAP = {
    100: "Thin",
    200: "ExtraLight",
    300: "Light",
    400: "Regular",
    500: "Medium",
    600: "SemiBold",
    700: "Bold",
    800: "ExtraBold",
    900: "Black"
  };
  var nodeCount = 0;
  function paintFromData(p) {
    if (p.type === "GRADIENT_LINEAR" && p.gradientStops && p.gradientStops.length >= 2) {
      var stops = [];
      for (var i = 0; i < p.gradientStops.length; i++) {
        var s = p.gradientStops[i];
        stops.push({
          position: s.position,
          color: { r: s.color.r, g: s.color.g, b: s.color.b, a: 1 }
        });
      }
      return {
        type: "GRADIENT_LINEAR",
        gradientTransform: [[1, 0, 0], [0, 1, 0]],
        gradientStops: stops
      };
    }
    if (p.type === "SOLID" && p.color) {
      return {
        type: "SOLID",
        color: { r: p.color.r, g: p.color.g, b: p.color.b },
        opacity: p.opacity !== void 0 ? p.opacity : 1
      };
    }
    return {
      type: "SOLID",
      color: { r: 0.5, g: 0.5, b: 0.5 },
      opacity: 1
    };
  }
  function base64ToBytes(base64) {
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var bufferLength = Math.floor(base64.length * 0.75);
    if (base64[base64.length - 1] === "=")
      bufferLength--;
    if (base64[base64.length - 2] === "=")
      bufferLength--;
    var bytes = new Uint8Array(bufferLength);
    var p = 0;
    for (var i = 0; i < base64.length; i += 4) {
      var a = chars.indexOf(base64[i]);
      var b = chars.indexOf(base64[i + 1]);
      var c = chars.indexOf(base64[i + 2]);
      var d = chars.indexOf(base64[i + 3]);
      bytes[p++] = a << 2 | b >> 4;
      if (c !== -1 && base64[i + 2] !== "=")
        bytes[p++] = (b & 15) << 4 | c >> 2;
      if (d !== -1 && base64[i + 3] !== "=")
        bytes[p++] = (c & 3) << 6 | d;
    }
    return bytes;
  }
  function applyImageData(node, imageData) {
    var bytes = base64ToBytes(imageData);
    var image = figma.createImage(bytes);
    node.fills = [{
      type: "IMAGE",
      imageHash: image.hash,
      scaleMode: "FILL"
    }];
  }
  function effectFromData(e) {
    const cr = e.color ? e.color.r : 0;
    const cg = e.color ? e.color.g : 0;
    const cb = e.color ? e.color.b : 0;
    const ca = e.opacity !== void 0 ? e.opacity : 0.25;
    const ox = e.offset ? e.offset.x : 0;
    const oy = e.offset ? e.offset.y : 4;
    const rad = e.radius !== void 0 ? e.radius : 4;
    if (e.type === "DROP_SHADOW") {
      return {
        type: "DROP_SHADOW",
        color: { r: cr, g: cg, b: cb, a: ca },
        offset: { x: ox, y: oy },
        radius: rad,
        visible: true,
        blendMode: "NORMAL"
      };
    }
    if (e.type === "INNER_SHADOW") {
      return {
        type: "INNER_SHADOW",
        color: { r: cr, g: cg, b: cb, a: ca },
        offset: { x: ox, y: oy },
        radius: rad,
        visible: true,
        blendMode: "NORMAL"
      };
    }
    return {
      type: "LAYER_BLUR",
      radius: rad,
      visible: true
    };
  }
  var HIRAGINO_WEIGHT_MAP = {
    100: "W3",
    200: "W3",
    300: "W3",
    400: "W3",
    500: "W6",
    600: "W6",
    700: "W6",
    800: "W6",
    900: "W6"
  };
  function fontWeightToStyle(weight, family) {
    if (family === "Hiragino Kaku Gothic ProN") {
      return HIRAGINO_WEIGHT_MAP[weight] || "W3";
    }
    return FONT_WEIGHT_MAP[weight] || "Regular";
  }
  async function loadFont(family, weight) {
    const style = fontWeightToStyle(weight, family);
    const font = { family, style };
    try {
      await figma.loadFontAsync(font);
      return font;
    } catch (e) {
      const fallbackStyle = FONT_WEIGHT_MAP[weight] || "Regular";
      const fallback = { family: "Inter", style: fallbackStyle };
      try {
        await figma.loadFontAsync(fallback);
        return fallback;
      } catch (e2) {
        const lastResort = { family: "Inter", style: "Regular" };
        await figma.loadFontAsync(lastResort);
        return lastResort;
      }
    }
  }
  async function createFrame(data) {
    const frame = figma.createFrame();
    frame.name = data.name || "Frame";
    frame.resize(data.width || 100, data.height || 100);
    if (data.x)
      frame.x = data.x;
    if (data.y)
      frame.y = data.y;
    if (data.layoutMode && data.layoutMode !== "NONE") {
      frame.layoutMode = data.layoutMode;
      frame.primaryAxisAlignItems = data.primaryAxisAlignItems || "MIN";
      frame.counterAxisAlignItems = data.counterAxisAlignItems || "MIN";
      frame.itemSpacing = data.itemSpacing || 0;
    }
    if (data.paddingLeft)
      frame.paddingLeft = data.paddingLeft;
    if (data.paddingRight)
      frame.paddingRight = data.paddingRight;
    if (data.paddingTop)
      frame.paddingTop = data.paddingTop;
    if (data.paddingBottom)
      frame.paddingBottom = data.paddingBottom;
    if (data.imageData) {
      applyImageData(frame, data.imageData);
    } else if (data.fills && data.fills.length > 0) {
      frame.fills = data.fills.map(paintFromData);
    } else {
      frame.fills = [];
    }
    if (data.cornerRadius) {
      frame.cornerRadius = data.cornerRadius;
    }
    if (data.clipsContent !== void 0) {
      frame.clipsContent = data.clipsContent;
    }
    if (data.effects && data.effects.length > 0) {
      frame.effects = data.effects.map(effectFromData);
    }
    if (data.strokes && data.strokes.length > 0) {
      frame.strokes = data.strokes.map(paintFromData);
      frame.strokeWeight = data.strokeWeight || 1;
      frame.strokeAlign = "INSIDE";
    }
    if (data.children) {
      for (var i = 0; i < data.children.length; i++) {
        var childData = data.children[i];
        var childNode = await createNode(childData);
        frame.appendChild(childNode);
        if (childData.layoutSizingHorizontal) {
          if (childNode.type === "FRAME") {
            childNode.layoutSizingHorizontal = childData.layoutSizingHorizontal;
          } else if (childNode.type === "TEXT") {
            childNode.layoutSizingHorizontal = childData.layoutSizingHorizontal;
          }
        }
        if (childData.layoutSizingVertical) {
          if (childNode.type === "FRAME") {
            childNode.layoutSizingVertical = childData.layoutSizingVertical;
          } else if (childNode.type === "TEXT") {
            childNode.layoutSizingVertical = childData.layoutSizingVertical;
          }
        }
      }
    }
    nodeCount++;
    return frame;
  }
  async function createText(data) {
    const text = figma.createText();
    const font = await loadFont(
      data.fontFamily || "Inter",
      data.fontWeight || 400
    );
    text.fontName = font;
    var chars = data.characters || "";
    var fontSize = data.fontSize || 14;
    text.characters = chars;
    text.fontSize = fontSize;
    text.name = data.name || `Text:${(data.characters || "").substring(0, 20)}`;
    if (data.x)
      text.x = data.x;
    if (data.y)
      text.y = data.y;
    if (data.width && data.height) {
      text.resize(data.width, data.height);
      text.textAutoResize = "NONE";
    } else if (data.width) {
      text.resize(data.width, data.height || fontSize);
      text.textAutoResize = "HEIGHT";
    } else {
      text.textAutoResize = "WIDTH_AND_HEIGHT";
    }
    if (data.fills && data.fills.length > 0) {
      text.fills = data.fills.map(paintFromData);
    }
    if (data.textAlignHorizontal) {
      text.textAlignHorizontal = data.textAlignHorizontal;
    }
    if (data.lineHeight) {
      text.lineHeight = {
        value: data.lineHeight * 100,
        unit: "PERCENT"
      };
    }
    if (data.letterSpacing) {
      text.letterSpacing = {
        value: data.letterSpacing,
        unit: "PIXELS"
      };
    }
    nodeCount++;
    return text;
  }
  async function createRectangle(data) {
    const rect = figma.createRectangle();
    rect.name = data.name || "Rectangle";
    rect.resize(data.width || 100, data.height || 100);
    if (data.x)
      rect.x = data.x;
    if (data.y)
      rect.y = data.y;
    if (data.imageData) {
      applyImageData(rect, data.imageData);
    } else if (data.fills && data.fills.length > 0) {
      rect.fills = data.fills.map(paintFromData);
    }
    if (data.cornerRadius) {
      rect.cornerRadius = data.cornerRadius;
    }
    if (data.effects && data.effects.length > 0) {
      rect.effects = data.effects.map(effectFromData);
    }
    if (data.strokes && data.strokes.length > 0) {
      rect.strokes = data.strokes.map(paintFromData);
      rect.strokeWeight = data.strokeWeight || 1;
      rect.strokeAlign = "INSIDE";
    }
    nodeCount++;
    return rect;
  }
  async function createNode(data) {
    var node;
    switch (data.type) {
      case "FRAME":
        node = await createFrame(data);
        break;
      case "TEXT":
        node = await createText(data);
        break;
      case "RECTANGLE":
        if (data.children && data.children.length > 0) {
          node = await createFrame(data);
        } else {
          node = await createRectangle(data);
        }
        break;
      case "ELLIPSE": {
        const ellipse = figma.createEllipse();
        ellipse.name = data.name || "Ellipse";
        ellipse.resize(data.width || 100, data.height || 100);
        if (data.x)
          ellipse.x = data.x;
        if (data.y)
          ellipse.y = data.y;
        if (data.fills && data.fills.length > 0) {
          ellipse.fills = data.fills.map(paintFromData);
        }
        nodeCount++;
        node = ellipse;
        break;
      }
      default:
        node = await createFrame(data);
    }
    if (data.opacity !== void 0 && data.opacity < 1) {
      node.opacity = data.opacity;
    }
    return node;
  }
  function getNodeCount() {
    return nodeCount;
  }
  function resetNodeCount() {
    nodeCount = 0;
  }

  // src/code.ts
  figma.showUI(__html__, { width: 480, height: 520 });
  figma.ui.onmessage = async (msg) => {
    if (msg.type === "import" && msg.data) {
      try {
        resetNodeCount();
        var rootNode = await createNode(msg.data.root);
        var screenshot = msg.data.metadata && msg.data.metadata.screenshot;
        if (screenshot) {
          var group = figma.createFrame();
          group.name = "Flutter Export";
          group.resize(
            msg.data.root.width || rootNode.width,
            msg.data.root.height || rootNode.height
          );
          group.fills = [];
          var screenshotRect = figma.createRectangle();
          screenshotRect.name = "Screenshot (Reference)";
          screenshotRect.resize(group.width, group.height);
          screenshotRect.opacity = 0.5;
          var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
          var bufferLength = Math.floor(screenshot.length * 0.75);
          if (screenshot[screenshot.length - 1] === "=")
            bufferLength--;
          if (screenshot[screenshot.length - 2] === "=")
            bufferLength--;
          var bytes = new Uint8Array(bufferLength);
          var p = 0;
          for (var i = 0; i < screenshot.length; i += 4) {
            var a = chars.indexOf(screenshot[i]);
            var b = chars.indexOf(screenshot[i + 1]);
            var c = chars.indexOf(screenshot[i + 2]);
            var d = chars.indexOf(screenshot[i + 3]);
            bytes[p++] = a << 2 | b >> 4;
            if (c !== -1 && screenshot[i + 2] !== "=")
              bytes[p++] = (b & 15) << 4 | c >> 2;
            if (d !== -1 && screenshot[i + 3] !== "=")
              bytes[p++] = (c & 3) << 6 | d;
          }
          var image = figma.createImage(bytes);
          screenshotRect.fills = [{
            type: "IMAGE",
            imageHash: image.hash,
            scaleMode: "FILL"
          }];
          group.appendChild(screenshotRect);
          group.appendChild(rootNode);
          figma.currentPage.appendChild(group);
          figma.viewport.scrollAndZoomIntoView([group]);
        } else {
          figma.currentPage.appendChild(rootNode);
          figma.viewport.scrollAndZoomIntoView([rootNode]);
        }
        figma.ui.postMessage({
          type: "done",
          nodeCount: getNodeCount()
        });
      } catch (e) {
        figma.ui.postMessage({
          type: "error",
          message: e.message || String(e)
        });
      }
    }
  };
})();
