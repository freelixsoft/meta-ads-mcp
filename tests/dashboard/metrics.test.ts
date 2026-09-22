import { describe, expect, it } from "vitest";
import {
  ADD_TO_CART_ACTION_TYPES,
  PURCHASE_ACTION_TYPES,
  deriveMetrics,
  pickAction,
  toNumber,
} from "../../src/dashboard/services/metrics.js";

describe("toNumber", () => {
  it("parses Meta's string numerics", () => {
    expect(toNumber("123.45")).toBe(123.45);
    expect(toNumber("0")).toBe(0);
    expect(toNumber(42)).toBe(42);
  });

  it("returns null rather than zero for missing or unparseable values", () => {
    expect(toNumber(undefined)).toBeNull();
    expect(toNumber(null)).toBeNull();
    expect(toNumber("")).toBeNull();
    expect(toNumber("   ")).toBeNull();
    expect(toNumber("n/a")).toBeNull();
    expect(toNumber(Number.NaN)).toBeNull();
    expect(toNumber(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("pickAction", () => {
  it("resolves in priority order, not in Meta's serialization order", () => {
    const actions = [
      { action_type: "purchase", value: "5" },
      { action_type: "omni_purchase", value: "3" },
    ];
    expect(pickAction(actions, PURCHASE_ACTION_TYPES)).toEqual({
      actionType: "omni_purchase",
      value: 3,
    });
  });

  it("falls through to the next alias when the preferred one is absent", () => {
    const actions = [{ action_type: "offsite_conversion.fb_pixel_purchase", value: "7" }];
    expect(pickAction(actions, PURCHASE_ACTION_TYPES)).toEqual({
      actionType: "offsite_conversion.fb_pixel_purchase",
      value: 7,
    });
  });

  it("returns null for a non-array field or no match", () => {
    expect(pickAction(undefined, PURCHASE_ACTION_TYPES)).toBeNull();
    expect(pickAction([], PURCHASE_ACTION_TYPES)).toBeNull();
    expect(pickAction([{ action_type: "link_click", value: "9" }], PURCHASE_ACTION_TYPES)).toBeNull();
  });

  it("recognises every add-to-cart alias", () => {
    for (const actionType of ADD_TO_CART_ACTION_TYPES) {
      expect(pickAction([{ action_type: actionType, value: "2" }], ADD_TO_CART_ACTION_TYPES)).toEqual({
        actionType,
        value: 2,
      });
    }
  });
});

describe("deriveMetrics", () => {
  it("derives CTR, CPC and CPM from the counters", () => {
    const metrics = deriveMetrics({
      spend: "100",
      impressions: "10000",
      clicks: "250",
      reach: "8000",
    });

    expect(metrics.ctr).toBeCloseTo(2.5, 10);
    expect(metrics.cpc).toBeCloseTo(0.4, 10);
    expect(metrics.cpm).toBeCloseTo(10, 10);
    expect(metrics.reach).toBe(8000);
  });

  it("never divides by zero — rates are null with no delivery", () => {
    const metrics = deriveMetrics({ spend: "0", impressions: "0", clicks: "0" });
    expect(metrics.ctr).toBeNull();
    expect(metrics.cpc).toBeNull();
    expect(metrics.cpm).toBeNull();
    expect(metrics.costPerPurchase).toBeNull();
    expect(metrics.roas).toBeNull();
  });

  it("does not double-count overlapping purchase aliases", () => {
    const metrics = deriveMetrics({
      spend: "200",
      actions: [
        { action_type: "omni_purchase", value: "10" },
        { action_type: "purchase", value: "10" },
        { action_type: "offsite_conversion.fb_pixel_purchase", value: "10" },
      ],
    });
    expect(metrics.purchases).toBe(10);
  });

  it("pairs purchase value with the same alias the count came from", () => {
    const metrics = deriveMetrics({
      spend: "100",
      actions: [{ action_type: "omni_purchase", value: "4" }],
      action_values: [
        { action_type: "omni_purchase", value: "800" },
        { action_type: "purchase", value: "999" },
      ],
    });
    expect(metrics.purchases).toBe(4);
    expect(metrics.purchaseValue).toBe(800);
  });

  it("prefers Meta's reported cost per purchase over spend / purchases", () => {
    const metrics = deriveMetrics({
      spend: "100",
      actions: [{ action_type: "omni_purchase", value: "4" }],
      cost_per_action_type: [{ action_type: "omni_purchase", value: "23.5" }],
    });
    expect(metrics.costPerPurchase).toBe(23.5);
  });

  it("falls back to spend / purchases when Meta omits the cost", () => {
    const metrics = deriveMetrics({
      spend: "100",
      actions: [{ action_type: "omni_purchase", value: "4" }],
    });
    expect(metrics.costPerPurchase).toBeCloseTo(25, 10);
  });

  it("prefers Meta's purchase_roas", () => {
    const metrics = deriveMetrics({
      spend: "100",
      actions: [{ action_type: "omni_purchase", value: "4" }],
      action_values: [{ action_type: "omni_purchase", value: "500" }],
      purchase_roas: [{ action_type: "omni_purchase", value: "4.75" }],
    });
    expect(metrics.roas).toBe(4.75);
  });

  it("derives ROAS from purchase value when purchase_roas is absent", () => {
    const metrics = deriveMetrics({
      spend: "200",
      actions: [{ action_type: "omni_purchase", value: "4" }],
      action_values: [{ action_type: "omni_purchase", value: "900" }],
    });
    expect(metrics.roas).toBeCloseTo(4.5, 10);
  });

  it("leaves ROAS null when no purchase value exists", () => {
    const metrics = deriveMetrics({
      spend: "200",
      actions: [{ action_type: "omni_purchase", value: "4" }],
    });
    expect(metrics.purchaseValue).toBeNull();
    expect(metrics.roas).toBeNull();
  });

  it("reads add-to-cart independently of purchases", () => {
    const metrics = deriveMetrics({
      spend: "50",
      actions: [
        { action_type: "omni_add_to_cart", value: "31" },
        { action_type: "omni_purchase", value: "3" },
      ],
    });
    expect(metrics.addToCart).toBe(31);
    expect(metrics.purchases).toBe(3);
  });

  it("treats an empty row as all zeros with null rates", () => {
    const metrics = deriveMetrics({});
    expect(metrics).toMatchObject({
      spend: 0,
      impressions: 0,
      reach: 0,
      clicks: 0,
      purchases: 0,
      addToCart: 0,
      ctr: null,
      cpc: null,
      cpm: null,
      purchaseValue: null,
      costPerPurchase: null,
      roas: null,
    });
  });
});
