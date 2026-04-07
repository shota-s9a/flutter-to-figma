/// External Dart CLI script — connects to Flutter debug app and exports
/// the render tree as Figma JSON (v5b: flat list + absolute coordinates).
///
/// Usage:
///   cd flutter_to_figma/tools
///   dart pub get
///   dart run figma_export.dart ws://127.0.0.1:XXXXX/TOKEN=/ws

import 'dart:convert';
import 'dart:io';

import 'package:image/image.dart' as img;
import 'package:vm_service/vm_service.dart';
import 'package:vm_service/vm_service_io.dart';

Future<void> main(List<String> args) async {
  if (args.isEmpty) {
    stderr.writeln('Usage: dart run figma_export.dart <vm_service_ws_uri>');
    exit(1);
  }

  final uri = args[0];
  final outputPath = args.length > 1
      ? args[1]
      : '../example-app/test/figma_output/top_page_devtools_raw.json';

  print('Connecting to $uri ...');
  final service = await vmServiceConnectUri(uri);
  print('Connected.');

  final vm = await service.getVM();
  final isolateRef = vm.isolates!.first;
  final isolateId = isolateRef.id!;
  print('Isolate: ${isolateRef.name} ($isolateId)');

  // Step 1: Get flat element list
  print('\n--- Calling ext.app.figmaExport ---');
  final exportResponse = await service.callServiceExtension(
    'ext.app.figmaExport',
    isolateId: isolateId,
  );
  final exportData = exportResponse.json!;

  if (exportData.containsKey('error')) {
    stderr.writeln('Error: ${exportData['error']}');
    await service.dispose();
    exit(1);
  }

  final screenWidth = (exportData['screenWidth'] as num).toDouble();
  final screenHeight = (exportData['screenHeight'] as num).toDouble();
  final contentHeight =
      (exportData['contentHeight'] as num?)?.toDouble() ?? screenHeight;
  final dpr = (exportData['devicePixelRatio'] as num).toDouble();
  final elements =
      List<Map<String, dynamic>>.from(exportData['elements'] as List);
  print('Screen: ${screenWidth}x$screenHeight @ ${dpr}x');
  print('Content height: $contentHeight');
  print('Elements: ${elements.length}');

  // Step 2: Multi-scroll screenshot capture
  print('\n--- Multi-scroll screenshot capture ---');
  final viewportHeight = screenHeight;
  final scrollPositions = <double>[0];
  double pos = viewportHeight * 0.8;
  while (pos < contentHeight) {
    scrollPositions.add(pos);
    pos += viewportHeight * 0.8;
  }
  print('Scroll positions: $scrollPositions');

  final compositeW = (screenWidth * dpr).round();
  final compositeH = (contentHeight * dpr).round();
  img.Image? composite;

  try {
    composite = img.Image(width: compositeW, height: compositeH);

    for (final scrollY in scrollPositions) {
      if (scrollY > 0) {
        await service.callServiceExtension(
          'ext.app.scrollTo',
          isolateId: isolateId,
          args: {'offset': '$scrollY'},
        );
        await Future.delayed(Duration(milliseconds: 300));
      }

      final screenshotResponse = await service.callServiceExtension(
        'ext.app.captureScreenshot',
        isolateId: isolateId,
        args: {'pixelRatio': '$dpr'},
      );
      final screenshotData = screenshotResponse.json!;
      if (!screenshotData.containsKey('screenshot')) continue;

      final base64Str = screenshotData['screenshot'] as String;
      final bytes = base64Decode(base64Str);
      final viewportImage = img.decodePng(bytes);
      if (viewportImage == null) continue;

      print(
          '  Scroll $scrollY: ${viewportImage.width}x${viewportImage.height}');

      final destY = (scrollY * dpr).round();
      for (int py = 0;
          py < viewportImage.height && destY + py < compositeH;
          py++) {
        for (int px = 0;
            px < viewportImage.width && px < compositeW;
            px++) {
          composite!
              .setPixel(px, destY + py, viewportImage.getPixel(px, py));
        }
      }
    }

    // Scroll back to top
    if (scrollPositions.length > 1) {
      await service.callServiceExtension(
        'ext.app.scrollTo',
        isolateId: isolateId,
        args: {'offset': '0'},
      );
    }

    print('Composite image: ${composite!.width}x${composite.height}');
  } catch (e) {
    print('Multi-scroll capture failed: $e');
    composite = null;
  }

  // Step 3a: Load asset images from file system
  final projectRoot = '/Users/shotashirai/Documents/example-app';
  int assetCount = 0;
  print('\n--- Loading asset images from files ---');
  for (final element in elements) {
    final assetPath = element['assetPath'] as String?;
    if (assetPath != null) {
      final file = File('$projectRoot/$assetPath');
      if (file.existsSync()) {
        element['imageData'] = base64Encode(file.readAsBytesSync());
        assetCount++;
        print('  Loaded: $assetPath');
      } else {
        print('  NOT FOUND: $assetPath');
      }
    }
  }
  print('Asset images loaded: $assetCount');

  // Step 3b: Crop network images from composite screenshot
  int capturedCount = 0;
  if (composite != null) {
    print('\n--- Cropping images from composite screenshot ---');
    for (final element in elements) {
      // Crop network images AND icons from screenshot
      if (element['_networkImage'] == true ||
          element['iconCodePoint'] != null) {
        final x = ((element['x'] as num) * dpr).round();
        final y = ((element['y'] as num) * dpr).round();
        final w = ((element['width'] as num) * dpr).round();
        final h = ((element['height'] as num) * dpr).round();

        if (x >= 0 &&
            y >= 0 &&
            w > 0 &&
            h > 0 &&
            x + w <= composite!.width &&
            y + h <= composite.height) {
          final cropped = img.copyCrop(
            composite,
            x: x,
            y: y,
            width: w,
            height: h,
          );
          element['imageData'] = base64Encode(img.encodePng(cropped));
          capturedCount++;
        }
      }
    }
    print('Images captured from screenshot: $capturedCount');
  }

  // Step 4: Build Figma JSON — flat children in one root FRAME
  print('\n--- Building Figma JSON ---');
  final figmaJson = {
    'metadata': {
      'exportDate': DateTime.now().toIso8601String(),
      'method': 'devtools_v5b',
      'screenSize': {'width': screenWidth, 'height': contentHeight},
      'devicePixelRatio': dpr,
    },
    'root': {
      'type': 'FRAME',
      'name': 'TopPage',
      'width': screenWidth,
      'height': contentHeight,
      'fills': [
        {
          'type': 'SOLID',
          'color': {'r': 1.0, 'g': 1.0, 'b': 1.0},
          'opacity': 1,
        }
      ],
      'clipsContent': true,
      'children': elements,
    },
  };

  // Step 5: Write output
  final outputFile = File(outputPath);
  outputFile.parent.createSync(recursive: true);
  outputFile.writeAsStringSync(
    const JsonEncoder.withIndent('  ').convert(figmaJson),
  );

  final fileSize = outputFile.lengthSync();
  print('\n=== Export Complete ===');
  print('Elements: ${elements.length}');
  print('Assets loaded: $assetCount');
  print('Images from screenshot: $capturedCount');
  print('Output: ${outputFile.path} ($fileSize bytes)');

  final byType = <String, int>{};
  for (final e in elements) {
    byType[e['type'] as String] = (byType[e['type']] ?? 0) + 1;
  }
  print('By type: $byType');

  await service.dispose();
}
