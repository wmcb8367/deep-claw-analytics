#!/bin/bash
# Test script for timing analytics API
# Usage: ./test-timing-api.sh <api_token> <api_base_url>

set -e

if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Usage: ./test-timing-api.sh <api_token> <api_base_url>"
  echo "Example: ./test-timing-api.sh dc_abc123... https://api.deepclaw.com"
  exit 1
fi

API_TOKEN="$1"
API_BASE="$2"

echo "🦞 Deep Claw Timing Analytics API Test"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

test_endpoint() {
  local name="$1"
  local endpoint="$2"
  local method="${3:-GET}"
  
  echo -e "${BLUE}Testing:${NC} $name"
  echo "  $method $endpoint"
  
  if [ "$method" = "GET" ]; then
    response=$(curl -s -w "\n%{http_code}" \
      -H "Authorization: Bearer $API_TOKEN" \
      "$API_BASE$endpoint")
  else
    response=$(curl -s -w "\n%{http_code}" \
      -X POST \
      -H "Authorization: Bearer $API_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$endpoint" \
      "$API_BASE/admin/aggregate-activity")
  fi
  
  http_code=$(echo "$response" | tail -n 1)
  body=$(echo "$response" | sed '$d')
  
  if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
    echo -e "  ${GREEN}✓${NC} HTTP $http_code"
    echo "  Response preview:"
    echo "$body" | jq -r '.' 2>/dev/null | head -20
  else
    echo -e "  ${RED}✗${NC} HTTP $http_code"
    echo "  Error:"
    echo "$body" | jq -r '.' 2>/dev/null || echo "$body"
  fi
  
  echo ""
}

# 1. Health check
test_endpoint "Health Check" "/health"

# 2. Auth check
test_endpoint "Authentication" "/auth/me"

# 3. Trigger aggregation first (so we have data)
echo -e "${BLUE}Triggering activity aggregation...${NC}"
curl -s -X POST \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"period": "30d"}' \
  "$API_BASE/admin/aggregate-activity" | jq
echo ""

# 4. Network activity - all types
test_endpoint "Network Activity (all, 30d)" "/metrics/timing/network-activity?type=all&period=30d"

# 5. Network activity - followers only
test_endpoint "Network Activity (followers, 7d)" "/metrics/timing/network-activity?type=followers&period=7d"

# 6. Best posting times
test_endpoint "Best Posting Times (30d)" "/insights/best-posting-times?period=30d"

# 7. Test different periods
test_endpoint "Best Posting Times (7d)" "/insights/best-posting-times?period=7d"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}✓${NC} All tests complete!"
echo ""
echo "Next steps:"
echo "  1. Check for 'zone_of_max_participation' in responses"
echo "  2. Verify 'recommendations' array has scored hours"
echo "  3. Confirm 'cached' field shows cache working"
echo "  4. Test rate limiting (make 100+ requests)"
