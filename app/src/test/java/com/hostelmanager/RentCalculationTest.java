package com.hostelmanager;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Assert;
import org.junit.Test;

import java.time.YearMonth;

public class RentCalculationTest {
    /*
     * NOTE: This test uses org.json.JSONArray and org.json.JSONObject.
     * The app/build.gradle file must include:
     *   testImplementation "org.json:json:20240303"
     * Without it, this file will not compile.
     */

    @Test
    public void testLegacyTenantNoHistory() throws Exception {
        YearMonth current = YearMonth.now();
        JSONObject tenant = new JSONObject()
                .put("id", "t1")
                .put("name", "Alice")
                .put("room", "A-1")
                .put("status", "Active")
                .put("joinDate", current.atDay(15).toString())
                .put("rent", 10000);

        JSONArray payments = new JSONArray();
        payments.put(payment("t1", current.toString(), 10000));

        JSONArray unpaid = ApiClient.calculateUnpaid(new JSONArray().put(tenant), payments);
        Assert.assertEquals(0, unpaid.length());
    }

    @Test
    public void testBillingStartsAfterHistoricalJoinDate() throws Exception {
        YearMonth current = YearMonth.now();
        YearMonth join = current.minusMonths(21);
        YearMonth billingStart = current.minusMonths(2);
        JSONObject tenant = tenantWithHistory(
                "t-billing-start",
                "Farah",
                "F-1",
                join.atDay(10).toString(),
                10000,
                new JSONArray().put(entry(join.toString(), 10000))
        );
        tenant.put("billingStartDate", billingStart.toString());

        JSONArray unpaid = ApiClient.calculateUnpaid(new JSONArray().put(tenant), new JSONArray());

        Assert.assertEquals(1, unpaid.length());
        Assert.assertEquals(3, unpaid.getJSONObject(0).getInt("monthsDue"));
        Assert.assertEquals(30000.0, unpaid.getJSONObject(0).getDouble("amountDue"), 0.01);
    }

    @Test
    public void testRentIncreaseSplitsCorrectly() throws Exception {
        YearMonth current = YearMonth.now();
        YearMonth join = current.minusMonths(8);
        YearMonth increase = current.minusMonths(2);
        JSONObject tenant = tenantWithHistory(
                "t2",
                "Bob",
                "B-2",
                join.atDay(10).toString(),
                10000,
                new JSONArray()
                        .put(entry(join.toString(), 10000))
                        .put(entry(increase.toString(), 12000))
        );

        JSONArray unpaid = ApiClient.calculateUnpaid(new JSONArray().put(tenant), new JSONArray());
        Assert.assertEquals(1, unpaid.length());
        Assert.assertEquals(9, unpaid.getJSONObject(0).getInt("monthsDue"));
        Assert.assertEquals(96000.0, unpaid.getJSONObject(0).getDouble("amountDue"), 0.01);
    }

    @Test
    public void testPartialPaymentAppliesToCorrectMonth() throws Exception {
        YearMonth current = YearMonth.now();
        YearMonth join = current.minusMonths(8);
        YearMonth increase = current.minusMonths(2);
        JSONObject tenant = tenantWithHistory(
                "t3",
                "Cara",
                "C-3",
                join.atDay(10).toString(),
                10000,
                new JSONArray()
                        .put(entry(join.toString(), 10000))
                        .put(entry(increase.toString(), 12000))
        );

        JSONArray payments = new JSONArray();
        payments.put(payment("t3", current.minusMonths(6).toString(), 5000));

        JSONArray unpaid = ApiClient.calculateUnpaid(new JSONArray().put(tenant), payments);
        Assert.assertEquals(1, unpaid.length());
        Assert.assertEquals(91000.0, unpaid.getJSONObject(0).getDouble("amountDue"), 0.01);
    }

    @Test
    public void testPaymentInWrongMonthDoesNotApply() throws Exception {
        YearMonth current = YearMonth.now();
        YearMonth join = current.minusMonths(8);
        YearMonth increase = current.minusMonths(2);
        JSONObject tenant = tenantWithHistory(
                "t4",
                "Dina",
                "D-4",
                join.atDay(10).toString(),
                10000,
                new JSONArray()
                        .put(entry(join.toString(), 10000))
                        .put(entry(increase.toString(), 12000))
        );

        JSONArray payments = new JSONArray();
        payments.put(payment("t4", current.minusMonths(1).toString(), 5000));

        JSONArray unpaid = ApiClient.calculateUnpaid(new JSONArray().put(tenant), payments);
        Assert.assertEquals(1, unpaid.length());
        Assert.assertEquals(96000.0, unpaid.getJSONObject(0).getDouble("amountDue"), 0.01);
    }

    @Test
    public void testRentDecreaseAlsoWorks() throws Exception {
        YearMonth current = YearMonth.now();
        YearMonth join = current.minusMonths(8);
        YearMonth decrease = current.minusMonths(2);
        JSONObject tenant = tenantWithHistory(
                "t5",
                "Evan",
                "E-5",
                join.atDay(10).toString(),
                12000,
                new JSONArray()
                        .put(entry(join.toString(), 12000))
                        .put(entry(decrease.toString(), 9000))
        );

        JSONArray unpaid = ApiClient.calculateUnpaid(new JSONArray().put(tenant), new JSONArray());
        Assert.assertEquals(1, unpaid.length());
        Assert.assertEquals(9, unpaid.getJSONObject(0).getInt("monthsDue"));
        Assert.assertEquals(99000.0, unpaid.getJSONObject(0).getDouble("amountDue"), 0.01);
    }

    @Test
    public void testChangeRentValidatesMonthOrder() throws Exception {
        JSONArray history = new JSONArray();
        history.put(entry("2024-06", 12000));
        history.put(entry("2024-05", 9000));
        Assert.assertThrows(IllegalArgumentException.class, () -> ApiClient.validateRentHistory(history));
    }

    @Test
    public void testChangeRentValidatesPositiveAmount() throws Exception {
        JSONArray history = new JSONArray();
        history.put(entry("2024-01", 10000));
        history.put(entry("2024-02", 0));
        Assert.assertThrows(IllegalArgumentException.class, () -> ApiClient.validateRentHistory(history));
    }

    private static JSONObject tenantWithHistory(String id, String name, String room, String joinDate,
                                              double rent, JSONArray rentHistory) throws Exception {
        JSONObject tenant = new JSONObject();
        tenant.put("id", id);
        tenant.put("name", name);
        tenant.put("room", room);
        tenant.put("status", "Active");
        tenant.put("joinDate", joinDate);
        tenant.put("rent", rent);
        tenant.put("rentHistory", rentHistory);
        return tenant;
    }

    private static JSONObject entry(String effectiveMonth, double amount) throws Exception {
        return new JSONObject().put("effectiveMonth", effectiveMonth).put("amount", amount);
    }

    private static JSONObject payment(String tenantId, String month, double amount) throws Exception {
        return new JSONObject().put("tenantId", tenantId).put("month", month).put("amount", amount);
    }
}
