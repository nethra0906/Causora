/** Entry point for one demo service: `node scripts/service.ts order|inventory|payment`. */
import { startInventoryService } from '../src/services/inventory.ts';
import { startOrderService } from '../src/services/order.ts';
import { startPaymentService } from '../src/services/payment.ts';

const which = process.argv[2];
const starters: Record<string, () => Promise<void>> = {
  order: () => startOrderService(Number(process.env.PORT) || undefined),
  inventory: () => startInventoryService(Number(process.env.PORT) || undefined),
  payment: () => startPaymentService(Number(process.env.PORT) || undefined),
};
const start = starters[which ?? ''];
if (!start) {
  console.error('usage: service.ts order|inventory|payment');
  process.exit(2);
}
await start();
console.log(`[${which}] ready`);
