# Image Converter Cloudflare Worker

This Cloudflare Worker converts SVG and GIF files to PNG (for static images) or MP4 (for animated content).

## Features

- Convert static SVG files to PNG
- Convert animated SVG files to MP4
- Convert static GIF files to PNG
- Convert animated GIF files to MP4

## Setup

1. Install dependencies:

```bash
npm install
```

2. Deploy the worker:

```bash
npm run deploy
```

## Usage

Send a POST request to the worker with a form-data containing the file to convert:

```bash
curl -X POST -F "file=@your-file.svg" https://your-worker-url.workers.dev
```

The worker will return:

- PNG file for static SVG or static GIF inputs
- MP4 file for animated SVG or animated GIF inputs

## Development

To run the worker locally:

```bash
npm run dev
```

## Note

The animated content conversion features (both SVG and GIF to MP4) are currently placeholders and need to be implemented. This would require additional libraries and more complex implementation to handle:

- For animated SVGs: parsing animation elements, extracting keyframes, and video encoding
- For animated GIFs: frame extraction and video encoding
