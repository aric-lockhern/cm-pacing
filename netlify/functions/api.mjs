// Netlify Function (v2): the dashboard's fast read API at /api, and /api/ingest for the Apps Script
// publisher. The logic lives in ../lib/fastapi.mjs so tests can drive it against an in-memory store.
import { getStore } from '@netlify/blobs';
import { handle } from '../lib/fastapi.mjs';

export default async (req) => handle(req, getStore({ name: 'cm-pacing', consistency: 'strong' }), { INGEST_SECRET: process.env.INGEST_SECRET });

export const config = { path: ['/api', '/api/ingest'] };
