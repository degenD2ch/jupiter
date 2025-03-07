import { workerData, parentPort } from 'worker_threads';
import pkg from '@solana/web3.js';
const { Connection, Keypair, VersionedTransaction, PublicKey, TransactionMessage, TOKEN_PROGRAM_ID } = pkg;
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import { createJupiterApiClient } from '@jup-ag/api';
import bs58 from 'bs58';
import fs from 'fs/promises';
import chalk from 'chalk'; // Добавляем chalk для цветного вывода

// Настройки
const RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';
const MINIMUM_TOKEN_AMOUNT = 1;
const MAX_SLIPPAGE_BPS = 100;
const FEE_RESERVE = 10000;
const SWAP_HISTORY_FILE = './swap_history.json';

const TOKENS = [
    { name: 'SOL', mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
    { name: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 },
    { name: 'Jito', mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', decimals: 6 },
    { name: 'WETH', mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', decimals: 8 },
    { name: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
    { name: 'WIF', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', decimals: 9 },
    { name: 'GIGA', mint: '63LfDmNb3MQ8mw9MtZ2To9bEA2M71kZUUGq5tiJxcqj9', decimals: 9 },
    { name: 'GRASS', mint: 'Grass7B4RdKfBCjTKgSqnXkqjwiGvQyFbuSCUJr3XXjs', decimals: 9 },
    { name: 'FARTCOIN', mint: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump', decimals: 9 },
    { name: 'TRUMP', mint: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN', decimals: 9 }
];

// Функция для генерации случайной задержки
function getRandomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Функция для случайного выбора числа транзакций в диапазоне
function getRandomTransactions(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Функция для случайного выбора токена (исключая SOL)
function getRandomToken(currentMint) {
    const availableTokens = TOKENS.filter(token => token.mint !== currentMint && token.mint !== TOKENS[0].mint);
    if (availableTokens.length === 0) return null;
    return availableTokens[Math.floor(Math.random() * availableTokens.length)];
}

// Рандомизация порядка токенов для свапов
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// Загрузка или инициализация истории свапов
async function loadSwapHistory() {
    try {
        const data = await fs.readFile(SWAP_HISTORY_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

// Сохранение истории свапов
async function saveSwapHistory(history) {
    await fs.writeFile(SWAP_HISTORY_FILE, JSON.stringify(history, null, 2));
}

// Получение или создания токен-аккаунта
async function getOrCreateTokenAccount(connection, wallet, mint) {
    const tokenMint = new PublicKey(mint);
    const tokenAccount = await getAssociatedTokenAddress(tokenMint, wallet.publicKey);
    const accountInfo = await connection.getAccountInfo(tokenAccount);

    if (!accountInfo) {
        parentPort.postMessage(`${wallet.publicKey.toString()} - Создание токен-аккаунта для ${mint}`);
        try {
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
            const messageV0 = new TransactionMessage({
                payerKey: wallet.publicKey,
                recentBlockhash: blockhash,
                instructions: [
                    createAssociatedTokenAccountInstruction(
                        wallet.publicKey,
                        tokenAccount,
                        wallet.publicKey,
                        tokenMint
                    )
                ]
            }).compileToV0Message();

            const transaction = new VersionedTransaction(messageV0);
            transaction.sign([wallet]);

            const txid = await connection.sendRawTransaction(transaction.serialize());
            await connection.confirmTransaction({ signature: txid, blockhash, lastValidBlockHeight });
            parentPort.postMessage(chalk.green(`${wallet.publicKey.toString()} - Токен-аккаунт создан: ${txid}`));
        } catch (error) {
            parentPort.postMessage(chalk.red(`${wallet.publicKey.toString()} - Не удалось создать токен-аккаунт для ${mint}: ${error.message}`));
            return null;
        }
    }
    return tokenAccount;
}

// Получение баланса токена
async function getTokenBalance(connection, wallet, mint) {
    const tokenAccount = await getAssociatedTokenAddress(new PublicKey(mint), wallet.publicKey);
    try {
        const balance = await connection.getTokenAccountBalance(tokenAccount);
        return parseInt(balance.value.amount);
    } catch (error) {
        return 0;
    }
}

// Получение баланса SOL с повторными попытками
async function getSolBalanceWithRetry(connection, publicKey, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const balance = await connection.getBalance(publicKey);
            return balance;
        } catch (error) {
            parentPort.postMessage(chalk.red(`${publicKey.toString()} - Попытка ${attempt} получения баланса SOL не удалась: ${error.message}`));
            if (attempt === retries) {
                throw new Error(`Не удалось получить баланс SOL после ${retries} попыток: ${error.message}`);
            }
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
    }
}

// Основная функция свапа
async function performSwap(connection, wallet, jupiterApi, inputMint, outputMint, amount, slippageBps = 50) {
    try {
        const solBalance = await getSolBalanceWithRetry(connection, wallet.publicKey);
        if (solBalance < 10000) throw new Error('Недостаточно SOL для оплаты комиссии');

        if (inputMint === outputMint) throw new Error('Исходный и целевой токены совпадают');

        const quote = await jupiterApi.quoteGet({
            inputMint,
            outputMint,
            amount,
            slippageBps,
        });

        const swapResponse = await jupiterApi.swapPost({
            swapRequest: {
                quoteResponse: quote,
                userPublicKey: wallet.publicKey.toString(),
                wrapAndUnwrapSol: true,
            },
        });

        const swapTransactionBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        transaction.sign([wallet]);

        let txid;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                txid = await connection.sendRawTransaction(transaction.serialize(), {
                    skipPreflight: false,
                    maxRetries: 5,
                });
                parentPort.postMessage(`${wallet.publicKey.toString()} - Транзакция отправлена: ${txid}`);
                break;
            } catch (err) {
                parentPort.postMessage(chalk.red(`${wallet.publicKey.toString()} - Попытка ${attempt} не удалась: ${err.message}`));
                if (attempt === 3) throw new Error('Не удалось отправить транзакцию после 3 попыток');
                await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
            }
        }

        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const latestBlockHash = await connection.getLatestBlockhash('confirmed');
                await connection.confirmTransaction({
                    blockhash: latestBlockHash.blockhash,
                    lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
                    signature: txid,
                });
                parentPort.postMessage(chalk.green(`${wallet.publicKey.toString()} - Свап успешно выполнен! TxID: ${txid}`));

                const history = await loadSwapHistory();
                history.push({
                    inputMint,
                    outputMint,
                    amount,
                    txid,
                    timestamp: new Date().toISOString(),
                    wallet: wallet.publicKey.toString()
                });
                await saveSwapHistory(history);

                return txid;
            } catch (error) {
                if (error instanceof pkg.TransactionExpiredBlockheightExceededError && attempt < 3) {
                    parentPort.postMessage(chalk.red(`${wallet.publicKey.toString()} - Попытка ${attempt} подтверждения не удалась: blockhash истёк, повторная попытка...`));
                    continue;
                }
                throw error;
            }
        }
    } catch (error) {
        parentPort.postMessage(chalk.red(`${wallet.publicKey.toString()} - Ошибка при свапе: ${error.message}`));
        return null;
    }
}

// Функция проверки начального баланса и свапа остатков в SOL
async function checkAndSwapInitialBalances(connection, wallet, jupiterApi) {
    parentPort.postMessage(`${wallet.publicKey.toString()} - Проверка начальных балансов токенов...`);
    for (const token of TOKENS) {
        if (token.mint !== TOKENS[0].mint) {
            const balance = await getTokenBalance(connection, wallet, token.mint);
            if (balance >= MINIMUM_TOKEN_AMOUNT) {
                parentPort.postMessage(`${wallet.publicKey.toString()} - Обнаружен остаток: ${balance / (10 ** token.decimals)} ${token.name}. Выполняю свап в SOL...`);
                const txid = await performSwap(connection, wallet, jupiterApi, token.mint, TOKENS[0].mint, balance, MAX_SLIPPAGE_BPS);
                if (!txid) {
                    parentPort.postMessage(chalk.red(`${wallet.publicKey.toString()} - Не удалось свапнуть ${token.name} в SOL`));
                }
            } else if (balance > 0) {
                parentPort.postMessage(`${wallet.publicKey.toString()} - Остаток ${token.name} слишком мал для обмена: ${balance / (10 ** token.decimals)} ${token.name}`);
            } else {
                parentPort.postMessage(`${wallet.publicKey.toString()} - Нет остатка ${token.name}`);
            }
        }
    }
}

// Главная функция для одного кошелька
async function runSingleWalletBot() {
    const { privateKey, transactionsMin, transactionsMax, solPercent, delayMinMs, delayMaxMs } = workerData;

    try {
        const connection = new Connection(RPC_ENDPOINT, 'confirmed');
        const wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
        const jupiterApi = createJupiterApiClient();

        parentPort.postMessage(`${wallet.publicKey.toString()} - Кошелек подключен`);
        let solBalance = await getSolBalanceWithRetry(connection, wallet.publicKey);
        parentPort.postMessage(`${wallet.publicKey.toString()} - Баланс кошелька: ${solBalance / 1_000_000_000} SOL`);

        await checkAndSwapInitialBalances(connection, wallet, jupiterApi);

        let initialAmount = Math.min(
            Math.floor(solBalance * solPercent),
            solBalance - FEE_RESERVE
        );
        if (initialAmount < 1000000) {
            parentPort.postMessage(chalk.red(`${wallet.publicKey.toString()} - Недостаточно SOL для начального свапа`));
            return;
        }

        for (const token of TOKENS) {
            if (token.mint !== TOKENS[0].mint) {
                const result = await getOrCreateTokenAccount(connection, wallet, token.mint);
                if (!result) {
                    parentPort.postMessage(chalk.red(`${wallet.publicKey.toString()} - Пропуск токена ${token.name} из-за ошибки при создания аккаунта`));
                    continue;
                }
            }
        }

        const totalTransactions = getRandomTransactions(transactionsMin, transactionsMax);
        parentPort.postMessage(`${wallet.publicKey.toString()} - Выбрано ${totalTransactions} транзакций для этого кошелька`);

        const steps = Array.from({ length: totalTransactions }, (_, i) => i + 1);
        shuffleArray(steps);

        let currentMint = TOKENS[0].mint;
        for (const step of steps) {
            await new Promise(resolve => setTimeout(resolve, getRandomDelay(delayMinMs, delayMaxMs)));
            const tokenBalance = await getTokenBalance(connection, wallet, currentMint);
            if (tokenBalance <= 0) {
                try {
                    solBalance = await getSolBalanceWithRetry(connection, wallet.publicKey);
                    initialAmount = Math.min(
                        Math.floor(solBalance * solPercent),
                        solBalance - FEE_RESERVE
                    );
                    if (initialAmount >= 1000000) {
                        const nextToken = getRandomToken(TOKENS[0].mint);
                        if (!nextToken) {
                            parentPort.postMessage(`${wallet.publicKey.toString()} - Пропуск шага ${step}: Нет доступных токенов для обмена SOL`);
                            break;
                        }
                        parentPort.postMessage(`${wallet.publicKey.toString()} - Шаг ${step}: Свап ${solPercent * 100}% SOL → ${nextToken.name} (дополнительный цикл)`);
                        await performSwap(connection, wallet, jupiterApi, TOKENS[0].mint, nextToken.mint, initialAmount);
                        currentMint = nextToken.mint;
                    } else {
                        parentPort.postMessage(chalk.red(`${wallet.publicKey.toString()} - Пропуск шага ${step}: Недостаточно SOL для продолжения`));
                        break;
                    }
                } catch (error) {
                    parentPort.postMessage(chalk.red(`${wallet.publicKey.toString()} - Ошибка при получении баланса SOL на шаге ${step}: ${error.message}`));
                    parentPort.postMessage(chalk.red(`${wallet.publicKey.toString()} - Пропуск шага ${step} из-за сетевой ошибки`));
                    break;
                }
            } else {
                const nextToken = getRandomToken(currentMint);
                if (!nextToken) {
                    parentPort.postMessage(`${wallet.publicKey.toString()} - Пропуск шага ${step}: Нет доступных токенов для обмена`);
                    break;
                }
                parentPort.postMessage(`${wallet.publicKey.toString()} - Шаг ${step}: Свап ${TOKENS.find(t => t.mint === currentMint)?.name || 'неизвестного токена'} → ${nextToken.name}`);
                await performSwap(connection, wallet, jupiterApi, currentMint, nextToken.mint, tokenBalance);
                currentMint = nextToken.mint;
            }
        }

        parentPort.postMessage(`${wallet.publicKey.toString()} - Запуск финального модуля: Свап всех токенов в SOL`);
        for (const token of TOKENS) {
            if (token.mint !== TOKENS[0].mint) {
                let tokenBalance = await getTokenBalance(connection, wallet, token.mint);
                if (tokenBalance >= MINIMUM_TOKEN_AMOUNT) {
                    await new Promise(resolve => setTimeout(resolve, getRandomDelay(delayMinMs, delayMaxMs)));
                    parentPort.postMessage(`${wallet.publicKey.toString()} - Финальный свап: ${token.name} → SOL (${tokenBalance / (10 ** token.decimals)} ${token.name})`);
                    const txid = await performSwap(connection, wallet, jupiterApi, token.mint, TOKENS[0].mint, tokenBalance, MAX_SLIPPAGE_BPS);
                    if (!txid) {
                        parentPort.postMessage(chalk.red(`${wallet.publicKey.toString()} - Пропуск токена ${token.name}: маршрут обмена не найден или недостаточный баланс`));
                    }
                } else if (tokenBalance > 0) {
                    parentPort.postMessage(`${wallet.publicKey.toString()} - Остаток ${token.name} слишком мал для обмена: ${tokenBalance / (10 ** token.decimals)} ${token.name}`);
                } else {
                    parentPort.postMessage(`${wallet.publicKey.toString()} - Нет ${token.name} для свапа`);
                }
            }
        }

        parentPort.postMessage(`${wallet.publicKey.toString()} - Все свапы завершены!`);
        const history = await loadSwapHistory();
        parentPort.postMessage(`${wallet.publicKey.toString()} - Всего выполнено свапов для этого кошелька: ${history.filter(h => h.wallet === wallet.publicKey.toString()).length}`);

    } catch (error) {
        parentPort.postMessage(chalk.red(`${wallet.publicKey.toString()} - Ошибка в работе бота: ${error.message}`));
    }
}

runSingleWalletBot();