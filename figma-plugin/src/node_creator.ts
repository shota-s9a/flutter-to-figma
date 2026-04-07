// Font weight number to Figma style name mapping.
const FONT_WEIGHT_MAP: Record<number, string> = {
  100: 'Thin',
  200: 'ExtraLight',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'SemiBold',
  700: 'Bold',
  800: 'ExtraBold',
  900: 'Black',
};

interface FigmaColor {
  r: number;
  g: number;
  b: number;
}

interface FigmaPaintData {
  type: string;
  color?: FigmaColor;
  opacity?: number;
  gradientStops?: { position: number; color: FigmaColor }[];
}

interface FigmaEffectData {
  type: string;
  color?: FigmaColor;
  opacity?: number;
  offset?: { x: number; y: number };
  radius?: number;
}

interface NodeData {
  type: string;
  name: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  layoutMode?: string;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  layoutSizingHorizontal?: string;
  layoutSizingVertical?: string;
  itemSpacing?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  fills?: FigmaPaintData[];
  strokes?: FigmaPaintData[];
  strokeWeight?: number;
  cornerRadius?: number;
  clipsContent?: boolean;
  effects?: FigmaEffectData[];
  characters?: string;
  fontSize?: number;
  fontWeight?: number;
  fontFamily?: string;
  textAlignHorizontal?: string;
  lineHeight?: number;
  letterSpacing?: number;
  maxLines?: number;
  imageData?: string; // Base64 encoded PNG
  opacity?: number;
  children?: NodeData[];
}

let nodeCount = 0;

function paintFromData(p: FigmaPaintData): SolidPaint | GradientPaint {
  if (p.type === 'GRADIENT_LINEAR' && p.gradientStops && p.gradientStops.length >= 2) {
    var stops: ColorStop[] = [];
    for (var i = 0; i < p.gradientStops.length; i++) {
      var s = p.gradientStops[i];
      stops.push({
        position: s.position,
        color: { r: s.color.r, g: s.color.g, b: s.color.b, a: 1 },
      });
    }
    return {
      type: 'GRADIENT_LINEAR',
      gradientTransform: [[1, 0, 0], [0, 1, 0]],
      gradientStops: stops,
    };
  }
  if (p.type === 'SOLID' && p.color) {
    return {
      type: 'SOLID',
      color: { r: p.color.r, g: p.color.g, b: p.color.b },
      opacity: p.opacity !== undefined ? p.opacity : 1,
    };
  }
  // Fallback
  return {
    type: 'SOLID',
    color: { r: 0.5, g: 0.5, b: 0.5 },
    opacity: 1,
  };
}

function base64ToBytes(base64: string): Uint8Array {
  // Manual Base64 decode for Figma Plugin environment
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var bufferLength = Math.floor(base64.length * 0.75);
  if (base64[base64.length - 1] === '=') bufferLength--;
  if (base64[base64.length - 2] === '=') bufferLength--;

  var bytes = new Uint8Array(bufferLength);
  var p = 0;

  for (var i = 0; i < base64.length; i += 4) {
    var a = chars.indexOf(base64[i]);
    var b = chars.indexOf(base64[i + 1]);
    var c = chars.indexOf(base64[i + 2]);
    var d = chars.indexOf(base64[i + 3]);

    bytes[p++] = (a << 2) | (b >> 4);
    if (c !== -1 && base64[i + 2] !== '=') bytes[p++] = ((b & 15) << 4) | (c >> 2);
    if (d !== -1 && base64[i + 3] !== '=') bytes[p++] = ((c & 3) << 6) | d;
  }

  return bytes;
}

function applyImageData(node: FrameNode | RectangleNode, imageData: string): void {
  var bytes = base64ToBytes(imageData);
  var image = figma.createImage(bytes);
  node.fills = [{
    type: 'IMAGE',
    imageHash: image.hash,
    scaleMode: 'FILL',
  } as ImagePaint];
}

function effectFromData(e: FigmaEffectData): Effect {
  const cr = e.color ? e.color.r : 0;
  const cg = e.color ? e.color.g : 0;
  const cb = e.color ? e.color.b : 0;
  const ca = e.opacity !== undefined ? e.opacity : 0.25;
  const ox = e.offset ? e.offset.x : 0;
  const oy = e.offset ? e.offset.y : 4;
  const rad = e.radius !== undefined ? e.radius : 4;

  if (e.type === 'DROP_SHADOW') {
    return {
      type: 'DROP_SHADOW',
      color: { r: cr, g: cg, b: cb, a: ca },
      offset: { x: ox, y: oy },
      radius: rad,
      visible: true,
      blendMode: 'NORMAL',
    };
  }
  if (e.type === 'INNER_SHADOW') {
    return {
      type: 'INNER_SHADOW',
      color: { r: cr, g: cg, b: cb, a: ca },
      offset: { x: ox, y: oy },
      radius: rad,
      visible: true,
      blendMode: 'NORMAL',
    };
  }
  // LAYER_BLUR
  return {
    type: 'LAYER_BLUR',
    radius: rad,
    visible: true,
  };
}

// Hiragino Kaku Gothic ProN uses W3/W6 style names
const HIRAGINO_WEIGHT_MAP: Record<number, string> = {
  100: 'W3', 200: 'W3', 300: 'W3', 400: 'W3',
  500: 'W6', 600: 'W6', 700: 'W6', 800: 'W6', 900: 'W6',
};

function fontWeightToStyle(weight: number, family: string): string {
  if (family === 'Hiragino Kaku Gothic ProN') {
    return HIRAGINO_WEIGHT_MAP[weight] || 'W3';
  }
  return FONT_WEIGHT_MAP[weight] || 'Regular';
}

async function loadFont(family: string, weight: number): Promise<FontName> {
  const style = fontWeightToStyle(weight, family);
  const font: FontName = { family, style };

  try {
    await figma.loadFontAsync(font);
    return font;
  } catch {
    // Fallback to Inter
    const fallbackStyle = FONT_WEIGHT_MAP[weight] || 'Regular';
    const fallback: FontName = { family: 'Inter', style: fallbackStyle };
    try {
      await figma.loadFontAsync(fallback);
      return fallback;
    } catch {
      const lastResort: FontName = { family: 'Inter', style: 'Regular' };
      await figma.loadFontAsync(lastResort);
      return lastResort;
    }
  }
}

async function createFrame(data: NodeData): Promise<FrameNode> {
  const frame = figma.createFrame();
  frame.name = data.name || 'Frame';
  frame.resize(data.width || 100, data.height || 100);

  if (data.x) frame.x = data.x;
  if (data.y) frame.y = data.y;

  // Auto Layout
  if (data.layoutMode && data.layoutMode !== 'NONE') {
    frame.layoutMode = data.layoutMode as 'HORIZONTAL' | 'VERTICAL';
    frame.primaryAxisAlignItems =
      (data.primaryAxisAlignItems as any) || 'MIN';
    frame.counterAxisAlignItems =
      (data.counterAxisAlignItems as any) || 'MIN';
    frame.itemSpacing = data.itemSpacing || 0;

  }

  // Padding
  if (data.paddingLeft) frame.paddingLeft = data.paddingLeft;
  if (data.paddingRight) frame.paddingRight = data.paddingRight;
  if (data.paddingTop) frame.paddingTop = data.paddingTop;
  if (data.paddingBottom) frame.paddingBottom = data.paddingBottom;

  // Fills (imageData takes priority)
  if (data.imageData) {
    applyImageData(frame, data.imageData);
  } else if (data.fills && data.fills.length > 0) {
    frame.fills = data.fills.map(paintFromData);
  } else {
    frame.fills = []; // Transparent by default
  }

  // Corner radius
  if (data.cornerRadius) {
    frame.cornerRadius = data.cornerRadius;
  }

  // Clips content
  if (data.clipsContent !== undefined) {
    frame.clipsContent = data.clipsContent;
  }

  // Effects
  if (data.effects && data.effects.length > 0) {
    frame.effects = data.effects.map(effectFromData);
  }

  // Strokes (borders)
  if (data.strokes && data.strokes.length > 0) {
    frame.strokes = data.strokes.map(paintFromData);
    frame.strokeWeight = data.strokeWeight || 1;
    frame.strokeAlign = 'INSIDE';
  }

  // Children
  if (data.children) {
    for (var i = 0; i < data.children.length; i++) {
      var childData = data.children[i];
      var childNode = await createNode(childData);
      frame.appendChild(childNode);
      // layoutSizing must be set AFTER appending to auto-layout parent
      if (childData.layoutSizingHorizontal) {
        if (childNode.type === 'FRAME') {
          (childNode as FrameNode).layoutSizingHorizontal = childData.layoutSizingHorizontal as any;
        } else if (childNode.type === 'TEXT') {
          (childNode as TextNode).layoutSizingHorizontal = childData.layoutSizingHorizontal as any;
        }
      }
      if (childData.layoutSizingVertical) {
        if (childNode.type === 'FRAME') {
          (childNode as FrameNode).layoutSizingVertical = childData.layoutSizingVertical as any;
        } else if (childNode.type === 'TEXT') {
          (childNode as TextNode).layoutSizingVertical = childData.layoutSizingVertical as any;
        }
      }
    }
  }

  nodeCount++;
  return frame;
}

async function createText(data: NodeData): Promise<TextNode> {
  const text = figma.createText();
  const font = await loadFont(
    data.fontFamily || 'Inter',
    data.fontWeight || 400,
  );
  text.fontName = font;

  // Characters — already truncated by DevTools extension with exact layout info
  var chars = data.characters || '';
  var fontSize = data.fontSize || 14;

  text.characters = chars;
  text.fontSize = fontSize;
  text.name =
    data.name || `Text:${(data.characters || '').substring(0, 20)}`;

  if (data.x) text.x = data.x;
  if (data.y) text.y = data.y;

  // Text sizing: use FIXED size from Flutter to prevent overflow
  if (data.width && data.height) {
    text.resize(data.width, data.height);
    text.textAutoResize = 'NONE'; // Fixed size — clips like Flutter does
  } else if (data.width) {
    text.resize(data.width, data.height || fontSize);
    text.textAutoResize = 'HEIGHT';
  } else {
    text.textAutoResize = 'WIDTH_AND_HEIGHT';
  }

  // Text fills (color)
  if (data.fills && data.fills.length > 0) {
    text.fills = data.fills.map(paintFromData);
  }

  // Text alignment
  if (data.textAlignHorizontal) {
    text.textAlignHorizontal = data.textAlignHorizontal as
      | 'LEFT'
      | 'CENTER'
      | 'RIGHT'
      | 'JUSTIFIED';
  }

  // Line height
  if (data.lineHeight) {
    text.lineHeight = {
      value: data.lineHeight * 100,
      unit: 'PERCENT',
    };
  }

  // Letter spacing
  if (data.letterSpacing) {
    text.letterSpacing = {
      value: data.letterSpacing,
      unit: 'PIXELS',
    };
  }

  nodeCount++;
  return text;
}

async function createRectangle(data: NodeData): Promise<RectangleNode> {
  const rect = figma.createRectangle();
  rect.name = data.name || 'Rectangle';
  rect.resize(data.width || 100, data.height || 100);

  if (data.x) rect.x = data.x;
  if (data.y) rect.y = data.y;

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
    rect.strokeAlign = 'INSIDE';
  }

  nodeCount++;
  return rect;
}

export async function createNode(data: NodeData): Promise<SceneNode> {
  var node: SceneNode;
  switch (data.type) {
    case 'FRAME':
      node = await createFrame(data);
      break;
    case 'TEXT':
      node = await createText(data);
      break;
    case 'RECTANGLE':
      // RECTANGLE with children → treat as FRAME (Figma rectangles can't have children)
      if (data.children && data.children.length > 0) {
        node = await createFrame(data);
      } else {
        node = await createRectangle(data);
      }
      break;
    case 'ELLIPSE': {
      const ellipse = figma.createEllipse();
      ellipse.name = data.name || 'Ellipse';
      ellipse.resize(data.width || 100, data.height || 100);
      if (data.x) ellipse.x = data.x;
      if (data.y) ellipse.y = data.y;
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
  // Apply opacity
  if (data.opacity !== undefined && data.opacity < 1) {
    node.opacity = data.opacity;
  }
  return node;
}

export function getNodeCount(): number {
  return nodeCount;
}

export function resetNodeCount(): void {
  nodeCount = 0;
}
