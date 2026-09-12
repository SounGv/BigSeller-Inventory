import 'dotenv/config';
import { withBigSellerPage } from '../src/utils/browser-runner.js';
import { printWaveShippingLabels } from '../src/services/wave-print-service.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  const result = await withBigSellerPage('print-com7-wave-labels', (page) => printWaveShippingLabels(page));
  console.log(`${result.waveCount} wave(s) / ${result.parcelCount} parcel(s) — printed: ${result.printed}`);
  await logger.info(`print:com7-wave-labels complete — ${JSON.stringify(result)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
