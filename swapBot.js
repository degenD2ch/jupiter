import { Worker } from 'worker_threads';
import fs from 'fs/promises';
import readline from 'readline';

// Создаём интерфейс для ввода данных пользователем
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Функция для запроса ввода пользователя
function askQuestion(query) {
    return new Promise((resolve) => rl.question(query, resolve));
}

// Чтение приватных ключей из файла wallets.txt
async function loadWallets() {
    try {
        const data = await fs.readFile('./wallets.txt', 'utf8');
        return data.trim().split('\n').filter(line => line.length > 0);
    } catch (error) {
        console.error('Ошибка при чтении wallets.txt:', error.message);
        return [];
    }
}

// Запуск бота с запросом параметров
async function runMultiWalletBot() {
    const privateKeys = await loadWallets();
    if (privateKeys.length === 0) {
        console.error('Не найдено приватных ключей в wallets.txt');
        rl.close();
        return;
    }

    console.log(`Найдено ${privateKeys.length} кошельков для обработки`);

    // Запрос диапазона количества свапов
    const transactionsMin = parseInt(await askQuestion('Введите минимальное количество свапов (например, 5): ') || 5);
    const transactionsMax = parseInt(await askQuestion('Введите максимальное количество свапов (например, 10): ') || 10);
    if (isNaN(transactionsMin) || isNaN(transactionsMax) || transactionsMin > transactionsMax) {
        console.error('Некорректный диапазон количества свапов. Используем значения по умолчанию: 5-10');
        transactionsMin = 5;
        transactionsMax = 10;
    }

    // Запрос временного интервала задержек
    const delayMinMs = parseInt(await askQuestion('Введите минимальную задержку в миллисекундах (например, 30000): ') || 30000);
    const delayMaxMs = parseInt(await askQuestion('Введите максимальную задержку в миллисекундах (например, 60000): ') || 60000);
    if (isNaN(delayMinMs) || isNaN(delayMaxMs) || delayMinMs > delayMaxMs) {
        console.error('Некорректный диапазон задержек. Используем значения по умолчанию: 30000-60000');
        delayMinMs = 30000;
        delayMaxMs = 60000;
    }

    // Процент SOL остаётся фиксированным
    const SOL_PERCENT = 0.9;

    console.log(`Параметры: Свапы от ${transactionsMin} до ${transactionsMax}, задержки от ${delayMinMs} до ${delayMaxMs} мс, ${SOL_PERCENT * 100}% SOL`);

    const workers = privateKeys.map((privateKey, index) => {
        return new Promise((resolve, reject) => {
            const worker = new Worker('./worker.js', {
                workerData: {
                    privateKey,
                    transactionsMin,
                    transactionsMax,
                    solPercent: SOL_PERCENT,
                    delayMinMs,
                    delayMaxMs,
                    workerId: index + 1
                }
            });

            worker.on('message', (msg) => console.log(msg));
            worker.on('error', reject);
            worker.on('exit', (code) => {
                if (code === 0) resolve(`Кошелек ${index + 1} завершил работу`);
                else reject(new Error(`Кошелек ${index + 1} завершился с кодом ${code}`));
            });
        });
    });

    try {
        await Promise.all(workers);
        console.log('Все кошельки обработаны');
    } catch (error) {
        console.error('Ошибка при выполнении потоков:', error);
    } finally {
        rl.close();
    }
}

runMultiWalletBot();