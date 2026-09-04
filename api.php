<?php
declare(strict_types=1);

set_time_limit(90);

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Access-Control-Expose-Headers: X-Scanner-Cache');
header('Vary: Origin');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    http_response_code(405);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'GET only']);
    exit;
}

$allowedPaths = [
    'derivatives/exchanges/alphax-futures' => true,
    'coins/markets' => true,
];

$path = $_GET['path'] ?? '';
if (!is_string($path) || !isset($allowedPaths[$path])) {
    http_response_code(400);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'path not allowed']);
    exit;
}

$allowedParams = [
    'include_tickers' => true,
    'vs_currency' => true,
    'ids' => true,
    'price_change_percentage' => true,
    'per_page' => true,
    'page' => true,
];

$query = [];
foreach ($_GET as $key => $value) {
    if ($key === 'path' || !isset($allowedParams[$key]) || !is_string($value)) {
        continue;
    }
    $query[$key] = $value;
}

$cacheDir = __DIR__ . '/cache';
if (!is_dir($cacheDir)) {
    mkdir($cacheDir, 0755, true);
}

$cacheTtl = 180;
$cacheKey = hash('sha256', $path . '?' . http_build_query($query));
$cacheFile = $cacheDir . '/' . $cacheKey . '.json';

if (is_file($cacheFile) && (time() - filemtime($cacheFile)) < $cacheTtl) {
    header('Content-Type: application/json; charset=utf-8');
    header('X-Scanner-Cache: HIT');
    header('Cache-Control: public, max-age=30');
    readfile($cacheFile);
    exit;
}

$config = [];
$configFile = __DIR__ . '/config.php';
if (is_file($configFile)) {
    $loaded = require $configFile;
    if (is_array($loaded)) {
        $config = $loaded;
    }
}
$demoKey = trim((string) ($config['coingecko_demo_key'] ?? ''));

$url = 'https://api.coingecko.com/api/v3/' . $path;
if ($query) {
    $url .= '?' . http_build_query($query);
}

$headers = [
    'Accept: application/json',
    'User-Agent: AlphaX-Turnover-Scanner/1.0',
];
if ($demoKey !== '') {
    $headers[] = 'x-cg-demo-api-key: ' . $demoKey;
}

$paceFile = $cacheDir . '/pace';
$pace = fopen($paceFile, 'c+');
if ($pace === false) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'cache unavailable']);
    exit;
}
flock($pace, LOCK_EX);
rewind($pace);
$last = (float) stream_get_contents($pace);
$minGap = $demoKey !== '' ? 2.2 : 4.0;
$wait = $minGap - (microtime(true) - $last);
if ($wait > 0) {
    usleep((int) round($wait * 1_000_000));
}

$body = false;
$errno = 0;
$status = 0;
$ctype = 'application/json';

for ($attempt = 0; $attempt < 4; $attempt++) {
    if ($attempt > 0) {
        sleep(8 * $attempt);
    }
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 25,
        CURLOPT_HTTPHEADER => $headers,
    ]);
    $body = curl_exec($ch);
    $errno = curl_errno($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $ctype = curl_getinfo($ch, CURLINFO_CONTENT_TYPE) ?: 'application/json';
    curl_close($ch);
    if ($body !== false && $errno === 0 && $status !== 429) {
        break;
    }
}

rewind($pace);
ftruncate($pace, 0);
fwrite($pace, (string) microtime(true));
fflush($pace);
flock($pace, LOCK_UN);
fclose($pace);

if ($body === false || $errno) {
    http_response_code(502);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'upstream failed']);
    exit;
}

if ($status === 200) {
    file_put_contents($cacheFile, $body);
}

http_response_code($status ?: 502);
header('Content-Type: ' . $ctype);
header('X-Scanner-Cache: MISS');
header('Cache-Control: public, max-age=30');
echo $body;
