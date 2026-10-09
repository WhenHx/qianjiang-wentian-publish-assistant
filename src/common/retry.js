function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function retry(fn, { attempts = 3, baseDelayMs = 200, shouldRetry = () => true } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await fn(attempt); }
    catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetry(error)) break;
      await sleep(baseDelayMs * attempt);
    }
  }
  throw lastError;
}

module.exports = { sleep, retry };