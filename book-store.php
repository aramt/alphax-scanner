<?php
declare(strict_types=1);

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Access-Control-Expose-Headers: X-Book-Status');
header('Vary: Origin');
header('Content-Type: application/json; charset=utf-8');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$key = $_GET['k'] ?? '';

if (!is_string($key) || !preg_match('/^[a-f0-9]{64}$/', $key)) {
    http_response_code(400);
    echo json_encode(['error' => 'bad key']);
    exit;
}

$dir = __DIR__ . '/data/books';
if (!is_dir($dir) && !mkdir($dir, 0755, true) && !is_dir($dir)) {
    http_response_code(500);
    echo json_encode(['error' => 'store unavailable']);
    exit;
}
$file = $dir . '/' . $key . '.json';

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'GET') {
    if (!is_file($file)) {
        echo json_encode(['stables' => 0, 'positions' => [], 'updated_at' => 0]);
        exit;
    }
    readfile($file);
    exit;
}

if ($method !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'GET or POST']);
    exit;
}

$raw = file_get_contents('php://input');
if (!is_string($raw) || strlen($raw) > 512000) {
    http_response_code(413);
    echo json_encode(['error' => 'payload too large']);
    exit;
}
$data = json_decode($raw, true);
if (!is_array($data) || !isset($data['positions']) || !is_array($data['positions'])) {
    http_response_code(400);
    echo json_encode(['error' => 'bad book']);
    exit;
}
unset($data['k']);
$data['updated_at'] = (int) ($data['updated_at'] ?? 0);
if ($data['updated_at'] <= 0) {
    $data['updated_at'] = (int) round(microtime(true) * 1000);
}
if (!isset($data['stables'])) {
    $data['stables'] = 0;
}

$encoded = json_encode($data, JSON_UNESCAPED_SLASHES);
if ($encoded === false) {
    http_response_code(400);
    echo json_encode(['error' => 'encode failed']);
    exit;
}
$ok = file_put_contents($file, $encoded, LOCK_EX);
if ($ok === false) {
    http_response_code(500);
    echo json_encode(['error' => 'write failed']);
    exit;
}
header('X-Book-Status: saved');
echo json_encode(['ok' => true, 'updated_at' => $data['updated_at']]);
