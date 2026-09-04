<?php
declare(strict_types=1);

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
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

$url = 'https://api.coingecko.com/api/v3/' . $path;
if ($query) {
    $url .= '?' . http_build_query($query);
}

$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_CONNECTTIMEOUT => 10,
    CURLOPT_TIMEOUT => 25,
    CURLOPT_HTTPHEADER => [
        'Accept: application/json',
        'User-Agent: AlphaX-Turnover-Scanner/1.0',
    ],
]);
$body = curl_exec($ch);
$errno = curl_errno($ch);
$status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
$ctype = curl_getinfo($ch, CURLINFO_CONTENT_TYPE) ?: 'application/json';
curl_close($ch);

if ($body === false || $errno) {
    http_response_code(502);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'upstream failed']);
    exit;
}

http_response_code($status ?: 502);
header('Content-Type: ' . $ctype);
header('Cache-Control: public, max-age=30');
echo $body;
