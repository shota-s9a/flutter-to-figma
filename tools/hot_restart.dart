import 'dart:async';
import 'dart:convert';
import 'dart:io';

Future<void> main() async {
  final uri = 'ws://127.0.0.1:57961/vesVNuM7XLQ=/ws';
  final ws = await WebSocket.connect(uri);
  final completer = <String, Completer<Map<String, dynamic>>>{};
  
  ws.listen((msg) {
    final data = jsonDecode(msg as String) as Map<String, dynamic>;
    final id = data['id']?.toString();
    if (id != null && completer.containsKey(id)) {
      completer[id]!.complete(data);
    }
  });
  
  Future<Map<String, dynamic>> call(String id, String method, [Map<String, dynamic>? params]) {
    completer[id] = Completer();
    ws.add(jsonEncode({
      'jsonrpc': '2.0',
      'method': method,
      'id': id,
      'params': params ?? {},
    }));
    return completer[id]!.future.timeout(Duration(seconds: 10));
  }
  
  // Get VM
  final vmResult = await call('1', 'getVM');
  final isolateId = (vmResult['result']['isolates'] as List).first['id'] as String;
  print('Isolate: $isolateId');
  
  // Hot restart
  try {
    final result = await call('2', 'ext.flutter.hotRestart', {'isolateId': isolateId});
    print('Hot restart: ${result['result'] ?? result['error']}');
  } catch (e) {
    print('Hot restart failed: $e');
    // Try reassemble instead
    try {
      final result = await call('3', 'ext.flutter.reassemble', {'isolateId': isolateId});
      print('Reassemble: ${result['result'] ?? result['error']}');
    } catch (e2) {
      print('Reassemble failed: $e2');
    }
  }
  
  await ws.close();
}
