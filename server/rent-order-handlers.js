export function createRentOrderSyncHandler(syncOrder) {
  return async function syncRentOrderHandler(req, res) {
    try {
      return res.json(await syncOrder(req.params.orderId));
    } catch (error) {
      console.error('PayPal order sync failed:', error);
      return res.status(502).json({
        error: error instanceof Error ? error.message : 'Could not sync the PayPal order.',
      });
    }
  };
}
