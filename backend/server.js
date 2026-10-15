import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { TranslateClient, TranslateTextCommand } from '@aws-sdk/client-translate';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

dotenv.config({ path: fileURLToPath(new URL('./.env', import.meta.url)) });

const app = express();
const port = Number(process.env.PORT || 5000);
const region = process.env.AWS_REGION || 'us-east-1';
const dataPath = fileURLToPath(new URL('./sentences_log.json', import.meta.url));
const fallbackPath = path.resolve('backend/sentences_log.json');
app.use(cors());
app.use(express.json({ limit: '32kb' }));

let database;
let writeQueue = Promise.resolve();
let translateClient;

async function loadDatabase() {
  const contents = await readFile(dataPath, 'utf8');
  database = JSON.parse(contents);
  database.presets ??= [];
  database.plays ??= [];
}

function persistDatabase() {
  const snapshot = JSON.stringify(database, null, 2);
  writeQueue = writeQueue.then(() => writeFile(dataPath, `${snapshot}\n`, 'utf8'));
  return writeQueue;
}

function normalizedText(value) {
  return value.normalize('NFC').replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/\s+/g, ' ').trim();
}

function levenshteinDistance(left, right) {
  const first = Array.from(normalizedText(left));
  const second = Array.from(normalizedText(right));
  let previous = Array.from({ length: second.length + 1 }, (_, index) => index);

  for (let row = 1; row <= first.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= second.length; column += 1) {
      const substitutionCost = first[row - 1] === second[column - 1] ? 0 : 1;
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + substitutionCost,
      );
    }
    previous = current;
  }

  return previous[second.length];
}

function similarityPercent(original, finalArabic) {
  const source = Array.from(normalizedText(original));
  const result = Array.from(normalizedText(finalArabic));
  const longest = Math.max(source.length, result.length);
  if (!longest) return 100;
  return Math.round((1 - levenshteinDistance(original, finalArabic) / longest) * 100);
}

const translationStages = [
  { key: 'japanese', language: 'Japanese', flag: '🇯🇵', source: 'ar', target: 'ja' },
  { key: 'russian', language: 'Russian', flag: '🇷🇺', source: 'ja', target: 'ru' },
  { key: 'french', language: 'French', flag: '🇫🇷', source: 'ru', target: 'fr' },
  { key: 'english', language: 'English', flag: '🇬🇧', source: 'fr', target: 'en' },
  { key: 'arabic', language: 'Arabic', flag: '🇵🇸', source: 'en', target: 'ar' },
];

function getTranslateClient() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey || accessKeyId === 'PASTE_KEY_HERE' || secretAccessKey === 'PASTE_SECRET_HERE') {
    const error = new Error('Add AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY to backend/.env to enable Amazon Translate.');
    error.statusCode = 503;
    throw error;
  }

  translateClient ??= new TranslateClient({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });
  return translateClient;
}

function awsTranslationError(cause) {
  const messages = {
    AccessDeniedException: 'AWS denied the Translate request. Check the key permissions include translate:TranslateText.',
    UnrecognizedClientException: 'AWS rejected these credentials. Check AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in backend/.env.',
    InvalidSignatureException: 'AWS rejected the credentials signature. Check the AWS keys in backend/.env.',
    ExpiredTokenException: 'The AWS credentials have expired. Update the credentials in backend/.env.',
    ResourceNotFoundException: 'Amazon Translate is unavailable for the configured AWS region.',
    UnsupportedLanguagePairException: 'Amazon Translate does not support one of the language pairs in this route.',
    ThrottlingException: 'Amazon Translate is busy. Wait a moment, then try again.',
  };
  const name = cause?.name;
  const error = new Error(messages[name] || 'Amazon Translate could not complete the translation. Check AWS credentials, region, and connectivity.');
  error.statusCode = name === 'AccessDeniedException' || name === 'UnrecognizedClientException' || name === 'InvalidSignatureException' || name === 'ExpiredTokenException' ? 503 : 502;
  console.error(`Amazon Translate failed: ${name || 'UnknownError'}${cause?.$metadata?.requestId ? ` (request ${cause.$metadata.requestId})` : ''}`);
  return error;
}

async function translateText(text, sourceLanguage, targetLanguage) {
  const client = getTranslateClient();
  try {
    const result = await client.send(new TranslateTextCommand({
      Text: text,
      SourceLanguageCode: sourceLanguage,
      TargetLanguageCode: targetLanguage,
    }));
    if (typeof result.TranslatedText !== 'string' || !result.TranslatedText.trim()) {
      throw new Error('Amazon Translate returned an empty translation.');
    }
    return result.TranslatedText.trim();
  } catch (cause) {
    if (cause.statusCode) throw cause;
    throw awsTranslationError(cause);
  }
}

async function createPipeline(original) {
  const steps = [];
  let text = original;

  for (const stage of translationStages) {
    text = await translateText(text, stage.source, stage.target);
    steps.push({ key: stage.key, language: stage.language, flag: stage.flag, text });
  }

  return { finalArabic: text, steps };
}

function getLeaderboard() {
  const guardians = database.plays
    .filter((play) => play.mode === 'guardian')
    .sort((a, b) => b.similarity - a.similarity || a.createdAt.localeCompare(b.createdAt))
    .slice(0, 5);
  const glitchers = database.plays
    .filter((play) => play.mode === 'glitcher')
    .sort((a, b) => a.similarity - b.similarity || a.createdAt.localeCompare(b.createdAt))
    .slice(0, 5);
  return { guardians, glitchers };
}

app.get('/api/presets', (_request, response) => {
  response.json(database.presets);
});

app.post('/api/log-sentence', async (request, response, next) => {
  try {
    const text = typeof request.body?.text === 'string' ? request.body.text.trim() : '';
    const category = typeof request.body?.category === 'string' ? request.body.category.trim().slice(0, 24) : 'Team';
    if (!text || Array.from(text).length > 150) {
      return response.status(400).json({ error: 'Enter a sentence of up to 150 characters.' });
    }
    const sentence = { id: randomUUID(), text, category: category || 'Team' };
    database.presets.unshift(sentence);
    await persistDatabase();
    return response.status(201).json(sentence);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/leaderboard', (_request, response) => {
  response.json(getLeaderboard());
});

app.post('/api/play', async (request, response, next) => {
  try {
    const { mode } = request.body ?? {};
    const original = typeof request.body?.sentence === 'string' ? request.body.sentence.trim() : '';
    const playerName = typeof request.body?.playerName === 'string' ? request.body.playerName.trim().slice(0, 30) : '';
    if (!['guardian', 'glitcher'].includes(mode)) {
      return response.status(400).json({ error: 'Choose a game mode first.' });
    }
    if (!original || Array.from(original).length > 150) {
      return response.status(400).json({ error: 'Enter a sentence between 1 and 150 characters.' });
    }
    if (!playerName) {
      return response.status(400).json({ error: 'Enter a player name.' });
    }

    const pipeline = await createPipeline(original);
    const play = {
      id: randomUUID(),
      playerName,
      mode,
      original,
      finalArabic: pipeline.finalArabic,
      similarity: similarityPercent(original, pipeline.finalArabic),
      createdAt: new Date().toISOString(),
    };
    database.plays.unshift(play);
    await persistDatabase();
    return response.status(201).json({ play, steps: pipeline.steps, leaderboard: getLeaderboard() });
  } catch (error) {
    return next(error);
  }
});

app.use((error, _request, response, _next) => {
  if (!error.statusCode) console.error(error);
  response.status(error.statusCode || 500).json({ error: error.message || 'Could not save local data.' });
});

loadDatabase()
  .then(() => app.listen(port, () => console.log(`DEVFEST booth API running at http://localhost:${port}`)))
  .catch(async (error) => {
    if (error.code !== 'ENOENT') throw error;
    const contents = await readFile(fallbackPath, 'utf8');
    database = JSON.parse(contents);
    app.listen(port, () => console.log(`DEVFEST booth API running at http://localhost:${port}`));
  });