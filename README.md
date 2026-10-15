# DEVFEST: Lost in Translation

A local English-language booth game for AWS Club at Birzeit University, Booth 2. Arabic sentences travel through Amazon Translate using the AWS SDK. Submitted sentences are sent to AWS for translation.

## Run locally

Requirements: Node.js 20 or newer and npm.

```sh
npm install
npm install --prefix backend
npm install --prefix frontend
npm run dev
```

In PowerShell, copy the environment template with `Copy-Item backend/.env.example backend/.env`, then open `backend/.env` and set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. The backend uses `AWS_REGION` or defaults to `us-east-1`. Keep keys private; they are only read by the backend and must never be added to frontend code. The IAM user needs permission for `translate:TranslateText`.

Open the Vite URL shown in the terminal (normally `http://localhost:5173`). The Express API runs at `http://localhost:5000`. To run only one side, use `npm run dev --prefix frontend` or `npm run dev --prefix backend`.

## Local data

`backend/sentences_log.json` stores presets, played sentences, player names, scores, and leaderboard history. Team-added sentences and successfully translated rounds are written to this file. Amazon Translate is called sequentially for Arabic, Japanese, Russian, French, English, and final Arabic; the frontend reveals each card at 800 ms intervals. Similarity is calculated with Levenshtein distance over normalized Arabic characters.

The seeded Guardian and Glitcher scores are example booth history and can be cleared by editing the `plays` array in the JSON file.