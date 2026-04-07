/// Debug-only service extension for Figma export (v8: RenderObject tree walk).
/// Walks the RenderObject tree directly (like Code to Canvas walks the DOM),
/// captures EVERY visible RenderBox, and builds a nested Figma JSON tree.
///
/// Registered via `assert()` pattern — completely tree-shaken in release.

import 'dart:async';
import 'dart:convert';
import 'dart:developer';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

void registerFigmaExportExtension() {
  assert(() {
    registerExtension('ext.app.figmaExport', _handleFigmaExport);
    registerExtension('ext.app.captureScreenshot', _handleCaptureScreenshot);
    registerExtension('ext.app.scrollTo', _handleScrollTo);
    return true;
  }());
}

// ==========================================================
// ext.app.figmaExport — RenderObject tree walk (DOM-style)
// ==========================================================

Future<ServiceExtensionResponse> _handleFigmaExport(
  String method,
  Map<String, String> parameters,
) async {
  try {
    final rootElement = WidgetsBinding.instance.rootElement;
    if (rootElement == null) {
      return ServiceExtensionResponse.error(
        ServiceExtensionResponse.extensionError,
        jsonEncode({'error': 'rootElement is null'}),
      );
    }

    final renderView = WidgetsBinding.instance.renderViews.first;
    final screenSize = renderView.size;
    final dpr = renderView.flutterView.devicePixelRatio;

    // ============================================================
    // Phase 1: Build Widget info map from Element tree
    // Maps RenderObject → Widget for text, image, icon metadata
    // ============================================================
    final widgetForRO = <RenderObject, Widget>{};
    final imageForRO = <RenderObject, Image>{};

    void mapWidgets(Element element) {
      final widget = element.widget;
      final ro = element.renderObject;

      if (widget is Image) {
        // Map Image widget to its RenderImage descendant
        void findRenderImage(RenderObject child) {
          if (child is RenderImage) {
            imageForRO[child] = widget;
          }
          widgetForRO[child] = widget;
          child.visitChildren(findRenderImage);
        }
        if (ro != null) {
          imageForRO[ro] = widget;
          widgetForRO[ro] = widget;
          ro.visitChildren(findRenderImage);
        }
      } else if (widget is Icon) {
        // Map Icon widget to its RenderParagraph descendant
        void findRenderParagraph(RenderObject child) {
          widgetForRO[child] = widget;
          child.visitChildren(findRenderParagraph);
        }
        if (ro != null) {
          widgetForRO[ro] = widget;
          ro.visitChildren(findRenderParagraph);
        }
      }

      element.visitChildren(mapWidgets);
    }
    mapWidgets(rootElement);

    // Collect offstage RenderObjects
    final offstageROs = <RenderObject>{};
    void collectOffstage(Element element) {
      if (element.widget is Offstage &&
          (element.widget as Offstage).offstage) {
        void markRO(Element e) {
          final ro = e.renderObject;
          if (ro != null) offstageROs.add(ro);
          e.visitChildren(markRO);
        }
        markRO(element);
        return;
      }
      element.visitChildren(collectOffstage);
    }
    collectOffstage(rootElement);

    // ============================================================
    // Phase 2: Walk RenderObject tree and build Figma node tree
    // ============================================================
    int nodeCount = 0;
    final renderImageNodes =
        <MapEntry<RenderImage, Map<String, dynamic>>>[];

    // Non-visual RenderObject types to skip entirely
    bool _isNonVisual(RenderObject ro) {
      final t = ro.runtimeType.toString();
      return t.contains('Semantics') ||
          t.contains('PointerListener') ||
          t.contains('MouseRegion') ||
          t.contains('TapRegion') ||
          t.contains('AbsorbPointer') ||
          t.contains('IgnorePointer') ||
          t.contains('BlockSemantics') ||
          t.contains('ExcludeSemantics') ||
          t.contains('GestureHandler') ||
          t.contains('RepaintBoundary') ||
          t.contains('AnnotatedRegion') ||
          t.contains('_InkFeatures') ||
          t.contains('InputPadding') ||
          t.contains('AnimatedOpacity') ||
          t.contains('LimitedBox') ||
          t.contains('CustomPaint') ||
          t.contains('_ScrollSemantics') ||
          t.contains('IndexedSemantics');
    }

    List<Map<String, dynamic>> visitRO(RenderObject ro) {
      if (offstageROs.contains(ro)) return const [];

      // Collect children from RO tree
      List<Map<String, dynamic>> collectChildren() {
        final childNodes = <Map<String, dynamic>>[];
        ro.visitChildren((child) {
          childNodes.addAll(visitRO(child));
        });
        return childNodes;
      }

      // Skip non-RenderBox (slivers, render views, etc.)
      if (ro is! RenderBox) return collectChildren();

      // Skip non-visual types
      if (_isNonVisual(ro)) return collectChildren();

      final box = ro;
      if (!box.hasSize) return collectChildren();
      final size = box.size;
      if (size.width <= 0 || size.height <= 0) return collectChildren();

      Offset pos;
      try {
        pos = box.localToGlobal(Offset.zero);
      } catch (_) {
        return collectChildren();
      }

      // Skip offscreen
      if (pos.dy + size.height < -10 || pos.dx + size.width < -10) {
        return collectChildren();
      }

      // Check if an Icon widget is associated with this RO
      final mappedWidget = widgetForRO[ro];

      // ==== LEAF: RenderParagraph → TEXT or ICON ====
      if (ro is RenderParagraph) {
        // Check if this is an Icon's text
        if (mappedWidget is Icon) {
          final icon = mappedWidget;
          final color = icon.color;
          final iconData = icon.icon;
          nodeCount++;
          return [
            {
              'type': 'RECTANGLE',
              'name': 'Icon:${iconData?.codePoint ?? "?"}',
              'x': _r(pos.dx),
              'y': _r(pos.dy),
              'width': _r(size.width),
              'height': _r(size.height),
              if (color != null) 'fills': [_colorToFill(color)],
              if (iconData?.codePoint != null)
                'iconCodePoint': iconData!.codePoint,
              if (iconData?.fontFamily != null)
                'iconFontFamily': iconData!.fontFamily,
            }
          ];
        }

        final plainText = ro.text.toPlainText();
        if (plainText.trim().isEmpty) return const [];

        final style = ro.text.style;
        String textAlign = 'LEFT';
        switch (ro.textAlign) {
          case TextAlign.center:
            textAlign = 'CENTER';
          case TextAlign.right:
          case TextAlign.end:
            textAlign = 'RIGHT';
          default:
            break;
        }

        String displayedText = plainText;
        bool wasTruncated = false;
        try {
          if (ro.didExceedMaxLines ||
              ro.overflow == TextOverflow.ellipsis) {
            final lastPos = ro.getPositionForOffset(
              Offset(size.width, size.height - 1),
            );
            if (lastPos.offset < plainText.length) {
              displayedText =
                  '${plainText.substring(0, lastPos.offset)}…';
              wasTruncated = true;
            }
          }
        } catch (_) {}

        final node = <String, dynamic>{
          'type': 'TEXT',
          'name':
              'Text:${plainText.length > 20 ? plainText.substring(0, 20) : plainText}',
          'x': _r(pos.dx),
          'y': _r(pos.dy),
          'width': _r(size.width),
          'height': _r(size.height),
          'characters': displayedText,
          if (wasTruncated) '_fullText': plainText,
          if (style?.color != null) 'fills': [_colorToFill(style!.color!)],
          'fontSize': style?.fontSize ?? 14,
          'fontWeight': (style?.fontWeight?.index ?? 3) * 100 + 100,
          'fontFamily': style?.fontFamily ?? 'Inter',
          'textAlignHorizontal': textAlign,
          if (style?.height != null) 'lineHeight': style!.height,
          if (style?.letterSpacing != null)
            'letterSpacing': style!.letterSpacing,
          if (style?.fontStyle == FontStyle.italic) 'fontStyle': 'italic',
        };
        if (ro.maxLines != null) node['maxLines'] = ro.maxLines;
        if (ro.overflow != TextOverflow.clip) {
          node['_textOverflow'] = ro.overflow.name;
        }
        nodeCount++;
        return [node];
      }

      // ==== LEAF: RenderEditable → TEXT ====
      if (ro is RenderEditable) {
        final plainText = ro.text?.toPlainText() ?? '';
        if (plainText.trim().isEmpty) return const [];
        final style = ro.text?.style;
        String textAlign = 'LEFT';
        switch (ro.textAlign) {
          case TextAlign.center:
            textAlign = 'CENTER';
          case TextAlign.right:
          case TextAlign.end:
            textAlign = 'RIGHT';
          default:
            break;
        }
        nodeCount++;
        return [
          {
            'type': 'TEXT',
            'name':
                'Text:${plainText.length > 20 ? plainText.substring(0, 20) : plainText}',
            'x': _r(pos.dx),
            'y': _r(pos.dy),
            'width': _r(size.width),
            'height': _r(size.height),
            'characters': plainText,
            if (style?.color != null) 'fills': [_colorToFill(style!.color!)],
            'fontSize': style?.fontSize ?? 14,
            'fontWeight': (style?.fontWeight?.index ?? 3) * 100 + 100,
            'fontFamily': style?.fontFamily ?? 'Inter',
            'textAlignHorizontal': textAlign,
            if (style?.height != null) 'lineHeight': style!.height,
            if (style?.letterSpacing != null)
              'letterSpacing': style!.letterSpacing,
          }
        ];
      }

      // ==== LEAF: RenderImage → RECTANGLE ====
      if (ro is RenderImage) {
        String imageName = 'Image:rendered';
        String? assetPath;
        bool isNetworkImage = false;

        final imgWidget = imageForRO[ro];
        if (imgWidget != null) {
          ImageProvider provider = imgWidget.image;
          if (provider is ResizeImage) provider = provider.imageProvider;
          if (provider is AssetImage) {
            assetPath = provider.assetName;
            imageName = 'Image:${assetPath.split('/').last}';
          } else if (provider is ExactAssetImage) {
            assetPath = provider.assetName;
            imageName = 'Image:${assetPath.split('/').last}';
          } else if (provider is NetworkImage) {
            imageName = 'Image:network';
            isNetworkImage = true;
          }
        } else {
          isNetworkImage = true;
        }

        final node = <String, dynamic>{
          'type': 'RECTANGLE',
          'name': imageName,
          'x': _r(pos.dx),
          'y': _r(pos.dy),
          'width': _r(size.width),
          'height': _r(size.height),
          'fills': [
            {
              'type': 'SOLID',
              'color': {'r': 0.85, 'g': 0.85, 'b': 0.85},
              'opacity': 1,
            }
          ],
          'cornerRadius': 4,
        };
        if (assetPath != null) node['assetPath'] = assetPath;
        if (isNetworkImage) node['_networkImage'] = true;
        renderImageNodes.add(MapEntry(ro, node));
        nodeCount++;
        return [node];
      }

      // ==== CONTAINER NODES: collect children first ====
      final children = collectChildren();

      // --- RenderPadding → transparent, attach padding info ---
      if (ro is RenderPadding) {
        final p = ro.padding.resolve(TextDirection.ltr);
        for (final child in children) {
          child['paddingLeft'] = _r(p.left);
          child['paddingRight'] = _r(p.right);
          child['paddingTop'] = _r(p.top);
          child['paddingBottom'] = _r(p.bottom);
        }
        return children;
      }

      // Extract visual properties
      final node = <String, dynamic>{
        'x': _r(pos.dx),
        'y': _r(pos.dy),
        'width': _r(size.width),
        'height': _r(size.height),
      };

      String name = '';
      bool hasVisual = false;

      // --- RenderDecoratedBox → fills, borders, shadows ---
      if (ro is RenderDecoratedBox) {
        final decoration = ro.decoration;
        if (decoration is BoxDecoration) {
          name = 'DecoratedBox';

          if (decoration.gradient is LinearGradient) {
            final g = decoration.gradient! as LinearGradient;
            node['fills'] = [
              {
                'type': 'GRADIENT_LINEAR',
                'gradientStops': g.colors.asMap().entries.map((e) {
                  final c = e.value;
                  final stop = g.stops != null && e.key < g.stops!.length
                      ? g.stops![e.key]
                      : e.key / (g.colors.length - 1);
                  return {
                    'position': stop,
                    'color': {'r': c.r, 'g': c.g, 'b': c.b},
                  };
                }).toList(),
              }
            ];
            hasVisual = true;
          } else if (decoration.color != null) {
            node['fills'] = [_colorToFill(decoration.color!)];
            hasVisual = true;
          }

          if (decoration.borderRadius != null) {
            final br = decoration.borderRadius!.resolve(TextDirection.ltr);
            final tl = br.topLeft.x;
            final tr = br.topRight.x;
            final bl = br.bottomLeft.x;
            final brr = br.bottomRight.x;
            if (tl > 0 || tr > 0 || bl > 0 || brr > 0) {
              if (tl == tr && tr == bl && bl == brr) {
                node['cornerRadius'] = _r(tl);
              } else {
                node['topLeftRadius'] = _r(tl);
                node['topRightRadius'] = _r(tr);
                node['bottomLeftRadius'] = _r(bl);
                node['bottomRightRadius'] = _r(brr);
              }
              hasVisual = true;
            }
          }

          if (decoration.boxShadow != null) {
            node['effects'] = decoration.boxShadow!
                .map((s) => {
                      'type': 'DROP_SHADOW',
                      'color': {
                        'r': s.color.r,
                        'g': s.color.g,
                        'b': s.color.b
                      },
                      'opacity': s.color.a,
                      'offset': {'x': s.offset.dx, 'y': s.offset.dy},
                      'radius': s.blurRadius,
                    })
                .toList();
            hasVisual = true;
          }

          if (decoration.border is Border) {
            final border = decoration.border! as Border;
            final top = border.top;
            if (top.width > 0 && top.color.a > 0) {
              node['strokes'] = [_colorToFill(top.color)];
              node['strokeWeight'] = top.width;
              hasVisual = true;
            }
          }
        }
      }

      // --- RenderPhysicalModel (Material) ---
      if (ro is RenderPhysicalModel) {
        name = 'Material';
        node['fills'] = [_colorToFill(ro.color)];
        hasVisual = true;
        // Extract borderRadius from RenderPhysicalModel
        final br = ro.borderRadius;
        if (br != null && br != BorderRadius.zero) {
          final resolved = br.resolve(TextDirection.ltr);
          final tl = resolved.topLeft.x;
          final tr = resolved.topRight.x;
          final bl = resolved.bottomLeft.x;
          final brr = resolved.bottomRight.x;
          if (tl == tr && tr == bl && bl == brr) {
            node['cornerRadius'] = _r(tl);
          } else {
            node['topLeftRadius'] = _r(tl);
            node['topRightRadius'] = _r(tr);
            node['bottomLeftRadius'] = _r(bl);
            node['bottomRightRadius'] = _r(brr);
          }
        }
        if (ro.elevation > 0) {
          node['effects'] = [
            {
              'type': 'DROP_SHADOW',
              'color': {'r': 0.0, 'g': 0.0, 'b': 0.0},
              'opacity': 0.15,
              'offset': {'x': 0, 'y': ro.elevation},
              'radius': ro.elevation * 2,
            }
          ];
        }
      }

      // --- RenderPhysicalShape ---
      if (ro is RenderPhysicalShape) {
        name = 'PhysicalShape';
        node['fills'] = [_colorToFill(ro.color)];
        hasVisual = true;
        double cr = size.height / 2;
        final clipper = ro.clipper;
        if (clipper is ShapeBorderClipper) {
          final shape = clipper.shape;
          if (shape is RoundedRectangleBorder &&
              shape.borderRadius is BorderRadius) {
            cr = (shape.borderRadius as BorderRadius)
                .resolve(TextDirection.ltr)
                .topLeft
                .x;
          }
        }
        node['cornerRadius'] = _r(cr);
        if (ro.elevation > 0) {
          node['effects'] = [
            {
              'type': 'DROP_SHADOW',
              'color': {'r': 0.0, 'g': 0.0, 'b': 0.0},
              'opacity': 0.15,
              'offset': {'x': 0, 'y': ro.elevation},
              'radius': ro.elevation * 2,
            }
          ];
        }
      }

      // --- _RenderColoredBox ---
      if (ro.runtimeType.toString().contains('ColoredBox')) {
        name = 'ColoredBox';
        try {
          // Access color via dynamic dispatch
          final dynamic dynRO = ro;
          final Color color = dynRO.color as Color;
          node['fills'] = [_colorToFill(color)];
          hasVisual = true;
        } catch (_) {}
      }

      // --- Layout: RenderFlex ---
      if (ro is RenderFlex) {
        name = ro.direction == Axis.vertical ? 'Column' : 'Row';
        // Store layout info as metadata (not as Figma auto-layout)
        node['_layoutMode'] =
            ro.direction == Axis.vertical ? 'VERTICAL' : 'HORIZONTAL';
      }

      // --- Layout: RenderStack ---
      if (ro is RenderStack) {
        name = 'Stack';
      }

      // --- RenderClipRRect (ClipRRect, Card, etc.) ---
      if (ro is RenderClipRRect) {
        node['clipsContent'] = true;
        if (name.isEmpty) name = 'ClipRRect';
        final br = ro.borderRadius;
        final resolved = br.resolve(TextDirection.ltr);
        final tl = resolved.topLeft.x;
        final tr = resolved.topRight.x;
        final bl = resolved.bottomLeft.x;
        final brr = resolved.bottomRight.x;
        if (tl > 0 || tr > 0 || bl > 0 || brr > 0) {
          if (tl == tr && tr == bl && bl == brr) {
            node['cornerRadius'] = _r(tl);
          } else {
            node['topLeftRadius'] = _r(tl);
            node['topRightRadius'] = _r(tr);
            node['bottomLeftRadius'] = _r(bl);
            node['bottomRightRadius'] = _r(brr);
          }
          hasVisual = true;
        }
      }

      // --- Clip containers ---
      if (ro is RenderClipRect || ro is RenderClipOval ||
          ro is RenderClipPath) {
        node['clipsContent'] = true;
        if (name.isEmpty) {
          name = ro is RenderClipOval
              ? 'ClipOval'
              : ro is RenderClipPath
                  ? 'ClipPath'
                  : 'ClipRect';
        }
      }

      // --- RenderCustomMultiChildLayoutBox (Scaffold, AppBar) ---
      if (ro is RenderCustomMultiChildLayoutBox) {
        if (name.isEmpty) name = 'Layout';
      }

      // ==== DECISION ====
      if (!hasVisual && name.isEmpty) {
        // Unknown non-visual RenderBox → transparent
        return children;
      }

      if (name.isEmpty) name = ro.runtimeType.toString();

      // Create node
      node['name'] = name;
      if (children.isNotEmpty) {
        node['type'] = 'FRAME';
        node['children'] = children;
      } else {
        node['type'] = hasVisual ? 'RECTANGLE' : 'FRAME';
      }
      if (!node.containsKey('fills')) node['fills'] = [];

      nodeCount++;
      return [node];
    }

    // Start walk from the render tree root
    final treeChildren = <Map<String, dynamic>>[];
    renderView.visitChildren((child) {
      treeChildren.addAll(visitRO(child));
    });

    // Extract pixel data from RenderImage objects
    int directImageCount = 0;
    for (final entry in renderImageNodes) {
      final ri = entry.key;
      final node = entry.value;
      if (node['assetPath'] != null) continue;
      try {
        final uiImage = ri.image;
        if (uiImage != null) {
          final byteData =
              await uiImage.toByteData(format: ui.ImageByteFormat.png);
          if (byteData != null) {
            node['imageData'] =
                base64Encode(byteData.buffer.asUint8List());
            node.remove('_networkImage');
            directImageCount++;
          }
        }
      } catch (_) {}
    }

    // Count total nodes
    int countNodes(List<dynamic> nodes) {
      int count = 0;
      for (final n in nodes) {
        count++;
        final children = n['children'] as List?;
        if (children != null) count += countNodes(children);
      }
      return count;
    }

    // Post-processing: unwrap full-screen Material backgrounds
    void pruneBackgrounds(List<dynamic> nodes) {
      for (int i = 0; i < nodes.length;) {
        final n = nodes[i] as Map<String, dynamic>;
        final name = n['name'] as String? ?? '';
        final w = (n['width'] as num?)?.toDouble() ?? 0;
        final h = (n['height'] as num?)?.toDouble() ?? 0;
        if (name == 'Material' &&
            w >= screenSize.width - 1 &&
            h >= screenSize.height * 0.8) {
          final children = n['children'] as List? ?? [];
          nodes.removeAt(i);
          nodes.insertAll(i, children);
        } else {
          final children = n['children'] as List?;
          if (children != null) pruneBackgrounds(children);
          i++;
        }
      }
    }
    pruneBackgrounds(treeChildren);

    // Collapse single-child wrapper chains
    void collapseWrappers(List<dynamic> nodes) {
      for (int i = 0; i < nodes.length; i++) {
        var n = nodes[i] as Map<String, dynamic>;
        final ch = n['children'] as List?;
        if (ch != null) collapseWrappers(ch);

        while (n['type'] == 'FRAME' && n['children'] is List) {
          final ch = n['children'] as List;
          if (ch.length != 1) break;
          final child = ch[0] as Map<String, dynamic>;
          if (child['type'] == 'TEXT' || child['type'] == 'RECTANGLE') break;

          final pw = (n['width'] as num?)?.toDouble() ?? 0;
          final ph = (n['height'] as num?)?.toDouble() ?? 0;
          final cw = (child['width'] as num?)?.toDouble() ?? 0;
          final childH = (child['height'] as num?)?.toDouble() ?? 0;
          final sameBounds = (pw - cw).abs() < 2 && (ph - childH).abs() < 2;
          if (!sameBounds) break;

          final fills = n['fills'] as List? ?? [];
          final hasVisualFills = fills.any((f) {
            final c = f['color'] as Map?;
            return c != null &&
                ((f['opacity'] as num?)?.toDouble() ?? 1.0) > 0.01;
          });
          final hasEffects = (n['effects'] as List?)?.isNotEmpty ?? false;
          final hasStrokes = (n['strokes'] as List?)?.isNotEmpty ?? false;

          if (hasVisualFills || hasEffects || hasStrokes) {
            // Visual parent: only collapse if child has same name
            if (n['name'] != child['name'] || !sameBounds) break;
          }

          child['x'] = n['x'];
          child['y'] = n['y'];
          nodes[i] = child;
          n = child;
        }
      }
    }
    collapseWrappers(treeChildren);

    // Convert absolute to relative coordinates
    void toRelativeCoords(
        List<dynamic> nodes, double parentX, double parentY) {
      for (final n in nodes) {
        final node = n as Map<String, dynamic>;
        final ax = (node['x'] as num?)?.toDouble() ?? 0;
        final ay = (node['y'] as num?)?.toDouble() ?? 0;
        node['x'] = _r(ax - parentX);
        node['y'] = _r(ay - parentY);
        final children = node['children'] as List?;
        if (children != null) toRelativeCoords(children, ax, ay);
      }
    }
    toRelativeCoords(treeChildren, 0, 0);

    // Expand clipped frames to contain all children
    // (scroll areas clip to viewport but we want full content visible in Figma)
    void expandClippedFrames(List<dynamic> nodes) {
      for (final n in nodes) {
        final node = n as Map<String, dynamic>;
        final children = node['children'] as List?;
        if (children != null) {
          expandClippedFrames(children);

          if (node['clipsContent'] == true) {
            // Measure children bounds
            double maxChildBottom = 0;
            double maxChildRight = 0;
            for (final c in children) {
              final cy = (c['y'] as num?)?.toDouble() ?? 0;
              final ch = (c['height'] as num?)?.toDouble() ?? 0;
              final cx = (c['x'] as num?)?.toDouble() ?? 0;
              final cw = (c['width'] as num?)?.toDouble() ?? 0;
              if (cy + ch > maxChildBottom) maxChildBottom = cy + ch;
              if (cx + cw > maxChildRight) maxChildRight = cx + cw;
            }
            final frameH = (node['height'] as num?)?.toDouble() ?? 0;
            final frameW = (node['width'] as num?)?.toDouble() ?? 0;
            // If children extend significantly beyond frame, expand it
            if (maxChildBottom > frameH + 10) {
              node['height'] = _r(maxChildBottom);
              node['clipsContent'] = false;
            }
            if (maxChildRight > frameW + 10) {
              node['width'] = _r(maxChildRight);
            }
          }
        }
      }
    }
    expandClippedFrames(treeChildren);

    // Measure content bounds
    double contentHeight = screenSize.height;
    double contentWidth = screenSize.width;
    void measureBounds(List<dynamic> nodes) {
      for (final e in nodes) {
        final y = (e['y'] as num?)?.toDouble() ?? 0;
        final h = (e['height'] as num?)?.toDouble() ?? 0;
        if (y + h > contentHeight) contentHeight = y + h;
        final x = (e['x'] as num?)?.toDouble() ?? 0;
        final w = (e['width'] as num?)?.toDouble() ?? 0;
        if (x + w > contentWidth) contentWidth = x + w;
        final children = e['children'] as List?;
        if (children != null) measureBounds(children);
      }
    }
    measureBounds(treeChildren);

    final totalNodes = countNodes(treeChildren);

    return ServiceExtensionResponse.result(jsonEncode({
      'screenWidth': screenSize.width,
      'screenHeight': screenSize.height,
      'contentHeight': contentHeight,
      'contentWidth': contentWidth,
      'devicePixelRatio': dpr,
      'elementCount': totalNodes,
      'totalVisited': nodeCount,
      'directImagesCaptured': directImageCount,
      'treeChildren': treeChildren,
    }));
  } catch (e, st) {
    return ServiceExtensionResponse.error(
      ServiceExtensionResponse.extensionError,
      jsonEncode({'error': e.toString(), 'stackTrace': st.toString()}),
    );
  }
}

// ==========================================================
// ext.app.captureScreenshot
// ==========================================================

Future<ServiceExtensionResponse> _handleCaptureScreenshot(
  String method,
  Map<String, String> parameters,
) async {
  try {
    final dpr = double.tryParse(parameters['pixelRatio'] ?? '') ?? 2.0;

    RenderRepaintBoundary? boundary;
    void findBoundary(RenderObject ro) {
      if (boundary != null) return;
      if (ro is RenderRepaintBoundary) {
        boundary = ro;
        return;
      }
      ro.visitChildren(findBoundary);
    }

    final renderView = WidgetsBinding.instance.renderViews.first;
    findBoundary(renderView);

    if (boundary == null) {
      return ServiceExtensionResponse.error(
        ServiceExtensionResponse.extensionError,
        jsonEncode({'error': 'No RenderRepaintBoundary found'}),
      );
    }

    _forcePaint();
    // ignore: invalid_use_of_protected_member
    final offsetLayer = boundary!.layer! as OffsetLayer;
    final image = await offsetLayer.toImage(
      Offset.zero & boundary!.size,
      pixelRatio: dpr,
    );
    final byteData = await image.toByteData(format: ui.ImageByteFormat.png);
    image.dispose();

    if (byteData == null) {
      return ServiceExtensionResponse.error(
        ServiceExtensionResponse.extensionError,
        jsonEncode({'error': 'toByteData returned null'}),
      );
    }

    final base64Png = base64Encode(byteData.buffer.asUint8List());
    return ServiceExtensionResponse.result(jsonEncode({
      'screenshot': base64Png,
      'width': boundary!.size.width,
      'height': boundary!.size.height,
      'pixelRatio': dpr,
    }));
  } catch (e, st) {
    return ServiceExtensionResponse.error(
      ServiceExtensionResponse.extensionError,
      jsonEncode({'error': e.toString(), 'stackTrace': st.toString()}),
    );
  }
}

// ==========================================================
// ext.app.scrollTo
// ==========================================================

Future<ServiceExtensionResponse> _handleScrollTo(
  String method,
  Map<String, String> parameters,
) async {
  try {
    final offset = double.tryParse(parameters['offset'] ?? '0') ?? 0.0;

    bool scrolled = false;
    void findAndScroll(Element element) {
      if (scrolled) return;
      if (element.widget is Scrollable) {
        final state = (element as StatefulElement).state;
        if (state is ScrollableState) {
          state.position.jumpTo(offset);
          scrolled = true;
          return;
        }
      }
      element.visitChildren(findAndScroll);
    }

    final rootElement = WidgetsBinding.instance.rootElement;
    if (rootElement != null) findAndScroll(rootElement);

    await Future<void>.delayed(const Duration(milliseconds: 100));

    return ServiceExtensionResponse.result(jsonEncode({
      'scrolled': scrolled,
      'offset': offset,
    }));
  } catch (e, st) {
    return ServiceExtensionResponse.error(
      ServiceExtensionResponse.extensionError,
      jsonEncode({'error': e.toString(), 'stackTrace': st.toString()}),
    );
  }
}

// ==========================================================
// Helpers
// ==========================================================

void _forcePaint() {
  final binding = WidgetsBinding.instance;
  binding.rootPipelineOwner.flushLayout();
  binding.rootPipelineOwner.flushCompositingBits();
  binding.rootPipelineOwner.flushPaint();
}

double _r(double v) => (v * 10).roundToDouble() / 10;

Map<String, dynamic> _colorToFill(Color c) => {
      'type': 'SOLID',
      'color': {'r': c.r, 'g': c.g, 'b': c.b},
      'opacity': c.a,
    };
