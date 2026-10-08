// Synthetic cloud responses are immediate; keep every verification query without wall-clock sleeps.
export function useFastSingleInstanceVerification() {
  let previousInterval: string | undefined;

  beforeAll(() => {
    previousInterval = process.env.SINGLE_INSTANCE_DESTROY_RETRY_INTERVAL_MS;
    process.env.SINGLE_INSTANCE_DESTROY_RETRY_INTERVAL_MS = '0';
  });

  afterAll(() => {
    if (previousInterval === undefined) {
      delete process.env.SINGLE_INSTANCE_DESTROY_RETRY_INTERVAL_MS;
    } else {
      process.env.SINGLE_INSTANCE_DESTROY_RETRY_INTERVAL_MS = previousInterval;
    }
  });
}
