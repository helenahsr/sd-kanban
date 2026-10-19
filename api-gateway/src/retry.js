const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Backoff exponencial com jitter: ~base * 2^tentativa, limitado a maxMs.
// O jitter evita que várias réplicas tentem reconectar exatamente ao mesmo tempo.
function backoffDelay(attempt, { baseMs = 500, maxMs = 15000 } = {}) {
    const exp = Math.min(maxMs, baseMs * 2 ** attempt);
    return Math.round(exp / 2 + Math.random() * (exp / 2));
}

// Executa fn com novas tentativas. `shouldRetry(err)` decide se o erro é transitório.
async function retry(fn, { retries = 3, baseMs, maxMs, shouldRetry = () => true, onRetry } = {}) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn(attempt);
        } catch (err) {
            if (attempt >= retries || !shouldRetry(err)) throw err;
            const delay = backoffDelay(attempt, { baseMs, maxMs });
            if (onRetry) onRetry(err, attempt + 1, delay);
            await sleep(delay);
        }
    }
}

// Rejeita se a promise não terminar dentro de `ms`
function withTimeout(promise, ms, label = 'operação') {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout de ${ms}ms em ${label}`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { sleep, backoffDelay, retry, withTimeout };
