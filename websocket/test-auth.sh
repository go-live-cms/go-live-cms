#!/bin/bash

# WebSocket Authentication Test Script
# This script tests if the WebSocket server correctly handles authentication

echo "🧪 WebSocket Authentication Test"
echo "================================="

# Check if required tools are available
if ! command -v wscat &> /dev/null; then
    echo "❌ wscat not found. Install with: npm install -g wscat"
    exit 1
fi

if ! command -v curl &> /dev/null; then
    echo "❌ curl not found. Please install curl"
    exit 1
fi

# Configuration
GO_API_URL=${GO_API_URL:-"http://localhost:8080"}
WS_URL=${WS_URL:-"ws://localhost:1234"}
TEST_USERNAME=${TEST_USERNAME:-"admin"}
TEST_PASSWORD=${TEST_PASSWORD:-"password"}

echo "📋 Test Configuration:"
echo "  Go API: $GO_API_URL"
echo "  WebSocket: $WS_URL"
echo "  Username: $TEST_USERNAME"
echo ""

# Test 1: Connection without token (should fail)
echo "🧪 Test 1: Connection without authentication token"
echo "Expected: Connection should be rejected"
timeout 5 wscat -c "$WS_URL" -w 1 2>/dev/null && echo "❌ FAIL: Connection without token was accepted" || echo "✅ PASS: Connection without token was rejected"
echo ""

# Test 2: Get access token
echo "🧪 Test 2: Getting access token from Go API"
TOKEN_RESPONSE=$(curl -s -X POST "$GO_API_URL/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$TEST_USERNAME\",\"password\":\"$TEST_PASSWORD\"}")

if echo "$TOKEN_RESPONSE" | grep -q "access_token"; then
    ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
    echo "✅ PASS: Successfully obtained access token"
    echo "  Token preview: ${ACCESS_TOKEN:0:20}..."
else
    echo "❌ FAIL: Could not obtain access token"
    echo "  Response: $TOKEN_RESPONSE"
    exit 1
fi
echo ""

# Test 3: Connection with valid token (should succeed)
echo "🧪 Test 3: Connection with valid authentication token"
echo "Expected: Connection should be accepted"
echo "Note: This test requires manual verification - watch WebSocket server logs"

# Create a test WebSocket connection with token
# Note: wscat doesn't support custom subprotocols easily, so we'll use query parameter as fallback
echo "Testing with token as query parameter (fallback method)..."
timeout 3 wscat -c "$WS_URL/?token=$ACCESS_TOKEN" -w 1 2>/dev/null && echo "✅ Token-based connection test completed" || echo "⚠️  Connection test completed (check server logs)"
echo ""

# Test 4: Check server logs for authentication messages
echo "🧪 Test 4: Server log verification"
echo "Check your WebSocket server terminal for these messages:"
echo "  ✅ Success: '✅ Token verified successfully for user: ...'"
echo "  ✅ Success: '🚀 WebSocket connection established for user: ...'"
echo "  ❌ Failure: '🚫 WebSocket authentication failed: ...'"
echo ""

echo "📝 Manual Testing Instructions:"
echo "  1. Start the Go API server: make dev"
echo "  2. Start the WebSocket server: cd websocket && npm start"  
echo "  3. Open the frontend and try collaborative editing"
echo "  4. Watch both server logs for authentication messages"
echo ""

echo "🎯 Expected Frontend Behavior:"
echo "  ✅ Collaborative editing should work when logged in"
echo "  ❌ WebSocket should fail when not authenticated"
echo "  🔄 Should reconnect with fresh token on expiry"
echo ""

echo "✨ Test script completed!"