// Source of e2e-demo/vendor/checkout.min.js (+ .map). Regenerate from apps/extension with:
// npx esbuild e2e-demo/vendor-src/checkout.js --bundle --minify --sourcemap --format=iife --outfile=e2e-demo/vendor/checkout.min.js

function computeCartTotal(items) {
  let total = 0;

  for (const item of items) {
    if (item.qty < 0) {
      throw new RangeError(`Invalid quantity for ${item.sku}`);
    }

    total += item.price * item.qty;
  }

  return total;
}

function checkoutCart(cart) {
  return computeCartTotal(cart.items);
}

window.wbStackDemo = {
  checkout: checkoutCart,
  failCheckout() {
    return checkoutCart({ items: [{ sku: "demo-sku", price: 2, qty: -1 }] });
  }
};
