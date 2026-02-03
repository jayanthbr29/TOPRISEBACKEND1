const axios = require('axios');




// Test script to verify the new SLA violations by dealer endpoint
async function testSLAViolationsByDealer() {
    const baseURL = 'http://localhost:5003'; // Order service URL

    // You'll need to replace these with actual values from your system
    const testDealerId = 'YOUR_DEALER_ID_HERE'; // Replace with actual dealer ID
    const authToken = 'YOUR_AUTH_TOKEN_HERE'; // Replace with valid auth token

    console.log('🧪 Testing SLA Violations by Dealer Endpoint...\n');

    try {
        // Test 1: Basic SLA violations by dealer (first page)
        console.log('1️⃣ Testing Basic SLA Violations by Dealer');

        try {
            const response = await axios.get(`${baseURL}/api/orders/sla/violations/dealer/${testDealerId}`, {
                headers: {
                    'Authorization': `Bearer ${authToken}`,
                    'Content-Type': 'application/json'
                }
            });

            console.log('✅ Basic SLA Violations Response:', {
                success: response.data.success,
                message: response.data.message,
                dealerId: response.data.data.dealerId,
                dealerInfo: response.data.data.dealerInfo ? 'Available' : 'Not Available',
                violationsCount: response.data.data.violations.length,
                summary: {
                    totalViolations: response.data.data.summary.totalViolations,
                    totalViolationMinutes: response.data.data.summary.totalViolationMinutes,
                    averageViolationMinutes: response.data.data.summary.averageViolationMinutes,
                    resolvedViolations: response.data.data.summary.resolvedViolations,
                    unresolvedViolations: response.data.data.summary.unresolvedViolations
                },
                pagination: response.data.data.pagination
            });

            // Show sample violation if available
            if (response.data.data.violations.length > 0) {
                const sampleViolation = response.data.data.violations[0];
                console.log('\n📋 Sample Violation:', {
                    violationMinutes: sampleViolation.violation_minutes,
                    violationHours: sampleViolation.violation_hours,
                    violationDays: sampleViolation.violation_days,
                    severity: sampleViolation.severity,
                    resolved: sampleViolation.resolved,
                    createdAt: sampleViolation.created_at
                });
            }

        } catch (error) {
            console.log('❌ Basic SLA Violations Error:', error.response?.data || error.message);
        }

        console.log('\n' + '='.repeat(50) + '\n');

        // Test 2: SLA violations with custom filters
        console.log('2️⃣ Testing SLA Violations with Custom Filters');

        const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
        const endDate = new Date().toISOString(); // Today

        try {
            const response = await axios.get(`${baseURL}/api/orders/sla/violations/dealer/${testDealerId}`, {
                headers: {
                    'Authorization': `Bearer ${authToken}`,
                    'Content-Type': 'application/json'
                },
                params: {
                    startDate: startDate,
                    endDate: endDate,
                    resolved: 'false', // Only unresolved violations
                    page: 1,
                    limit: 5,
                    sortBy: 'violation_minutes',
                    sortOrder: 'desc'
                }
            });

            console.log('✅ Filtered SLA Violations Response:', {
                success: response.data.success,
                violationsCount: response.data.data.violations.length,
                totalViolations: response.data.data.summary.totalViolations,
                filters: response.data.data.filters,
                pagination: response.data.data.pagination
            });

        } catch (error) {
            console.log('❌ Filtered SLA Violations Error:', error.response?.data || error.message);
        }

        console.log('\n' + '='.repeat(50) + '\n');

        // Test 3: Test with invalid dealer ID
        console.log('3️⃣ Testing with Invalid Dealer ID');

        try {
            const response = await axios.get(`${baseURL}/api/orders/sla/violations/dealer/invalid_dealer_id`, {
                headers: {
                    'Authorization': `Bearer ${authToken}`,
                    'Content-Type': 'application/json'
                }
            });

            console.log('✅ Invalid Dealer ID Response:', response.data);

        } catch (error) {
            console.log('❌ Invalid Dealer ID Error (Expected):', error.response?.data || error.message);
        }

        console.log('\n' + '='.repeat(50) + '\n');

        // Test 4: Test without authentication
        console.log('4️⃣ Testing without Authentication');

        try {
            const response = await axios.get(`${baseURL}/api/orders/sla/violations/dealer/${testDealerId}`);

            console.log('✅ No Auth Response:', response.data);

        } catch (error) {
            console.log('❌ No Auth Error (Expected):', error.response?.data || error.message);
        }

        console.log('\n' + '='.repeat(50) + '\n');

        // Test 5: Test pagination
        console.log('5️⃣ Testing Pagination');

        try {
            const response = await axios.get(`${baseURL}/api/orders/sla/violations/dealer/${testDealerId}`, {
                headers: {
                    'Authorization': `Bearer ${authToken}`,
                    'Content-Type': 'application/json'
                },
                params: {
                    page: 2,
                    limit: 3
                }
            });

            console.log('✅ Pagination Response:', {
                currentPage: response.data.data.pagination.currentPage,
                totalPages: response.data.data.pagination.totalPages,
                totalViolations: response.data.data.pagination.totalViolations,
                hasNextPage: response.data.data.pagination.hasNextPage,
                hasPrevPage: response.data.data.pagination.hasPrevPage,
                violationsOnThisPage: response.data.data.violations.length
            });

        } catch (error) {
            console.log('❌ Pagination Error:', error.response?.data || error.message);
        }

    } catch (error) {
        console.error('❌ Test failed:', error.message);
    }

    console.log('\n🏁 Test completed!');
    console.log('\n📝 Instructions:');
    console.log('1. Replace YOUR_DEALER_ID_HERE with an actual dealer ID from your database');
    console.log('2. Replace YOUR_AUTH_TOKEN_HERE with a valid authentication token');
    console.log('3. Make sure the order-service is running on port 5003');
    console.log('4. Run: node test-sla-violations-by-dealer.js');
    console.log('\n📊 Expected Response Structure:');
    console.log(`
{
  "success": true,
  "message": "SLA violations by dealer fetched successfully",
  "data": {
    "dealerId": "dealer_id",
    "dealerInfo": {
      "dealerId": "DEALER_001",
      "legal_name": "Dealer Name",
      "trade_name": "Trade Name"
    },
    "violations": [
      {
        "_id": "violation_id",
        "dealer_id": "dealer_id",
        "order_id": {
          "orderId": "ORD_001",
          "totalAmount": 1000,
          "orderDate": "2024-01-01T00:00:00.000Z"
        },
        "expected_fulfillment_time": "2024-01-01T12:00:00.000Z",
        "actual_fulfillment_time": "2024-01-01T14:30:00.000Z",
        "violation_minutes": 150,
        "violation_hours": 2.5,
        "violation_days": 0.1,
        "severity": "Medium",
        "resolved": false,
        "created_at": "2024-01-01T14:30:00.000Z"
      }
    ],
    "summary": {
      "totalViolations": 25,
      "totalViolationMinutes": 3750,
      "averageViolationMinutes": 150,
      "resolvedViolations": 10,
      "unresolvedViolations": 15,
      "maxViolationMinutes": 480,
      "minViolationMinutes": 30
    },
    "violationsByDate": {
      "2024-01-01": {
        "count": 3,
        "totalMinutes": 450,
        "violations": [...]
      }
    },
    "pagination": {
      "currentPage": 1,
      "totalPages": 3,
      "totalViolations": 25,
      "limit": 10,
      "hasNextPage": true,
      "hasPrevPage": false,
      "nextPage": 2,
      "prevPage": null
    },
    "filters": {
      "startDate": null,
      "endDate": null,
      "resolved": null,
      "sortBy": "created_at",
      "sortOrder": "desc"
    }
  }
}
  `);
}

// Run the test
testSLAViolationsByDealer();
