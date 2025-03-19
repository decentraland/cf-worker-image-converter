/// <reference types="@cloudflare/workers-types" />

import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'

interface Env {
  // Add any environment variables here if needed
}

interface Dimensions {
  width: number
  height: number
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Only allow POST requests
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 })
    }

    try {
      // Get the file from the request
      const formData = await request.formData()
      const file = formData.get('file') as File

      if (!file) {
        return new Response('No file provided', { status: 400 })
      }

      // Check file type
      const fileType = file.type
      if (!['image/svg+xml', 'image/gif'].includes(fileType)) {
        return new Response('Invalid file type. Only SVG and GIF files are supported.', { status: 400 })
      }

      // Read the file content
      const fileBuffer = await file.arrayBuffer()

      // For SVG files, check if animated and convert accordingly
      if (fileType === 'image/svg+xml') {
        const svgText = new TextDecoder().decode(fileBuffer)
        const isAnimated = isAnimatedSVG(svgText)

        if (isAnimated) {
          const mp4 = await convertAnimatedSVGtoMP4(svgText)
          return new Response(mp4, {
            headers: {
              'Content-Type': 'video/mp4',
              'Content-Disposition': 'attachment; filename="converted.mp4"'
            }
          })
        } else {
          const image = await convertSVGtoPNG(svgText)
          return new Response(image, {
            headers: {
              'Content-Type': 'image/png',
              'Content-Disposition': 'attachment; filename="converted.png"'
            }
          })
        }
      }

      // For GIF files, check if animated and convert accordingly
      if (fileType === 'image/gif') {
        const isAnimated = await isAnimatedGIF(fileBuffer)
        if (isAnimated) {
          const mp4 = await convertGIFtoMP4(fileBuffer)
          return new Response(mp4, {
            headers: {
              'Content-Type': 'video/mp4',
              'Content-Disposition': 'attachment; filename="converted.mp4"'
            }
          })
        } else {
          const png = await convertGIFtoPNG(fileBuffer)
          return new Response(png, {
            headers: {
              'Content-Type': 'image/png',
              'Content-Disposition': 'attachment; filename="converted.png"'
            }
          })
        }
      }

      return new Response('Unsupported file type', { status: 400 })
    } catch (error) {
      console.error('Error processing file:', error)
      return new Response('Error processing file', { status: 500 })
    }
  }
}

function isAnimatedSVG(svgText: string): boolean {
  // Check for SMIL animation elements
  const animationElements = ['<animate', '<animateTransform', '<animateMotion', '<set']
  return animationElements.some(element => svgText.includes(element))
}

function getSVGDimensions(svgText: string): Dimensions {
  const parser = new DOMParser()
  const doc = parser.parseFromString(svgText, 'image/svg+xml')
  const svgElement = doc.documentElement

  // Get width and height from viewBox or width/height attributes
  const viewBox = svgElement.getAttribute('viewBox')
  if (viewBox) {
    const [, , width, height] = viewBox.split(' ').map(Number)
    return { width, height }
  }

  const width = parseFloat(svgElement.getAttribute('width') || '800')
  const height = parseFloat(svgElement.getAttribute('height') || '600')

  return { width, height }
}

function getGIFDimensions(buffer: ArrayBuffer): Dimensions {
  const view = new Uint8Array(buffer)
  // GIF header contains width and height at bytes 6-9 (little-endian)
  const width = view[6] | (view[7] << 8)
  const height = view[8] | (view[9] << 8)
  return { width, height }
}

async function convertSVGtoPNG(svgText: string): Promise<ArrayBuffer> {
  const dimensions = getSVGDimensions(svgText)
  const img = new Image()
  const canvas = new OffscreenCanvas(dimensions.width, dimensions.height)
  const ctx = canvas.getContext('2d')

  return new Promise((resolve, reject) => {
    img.onload = () => {
      ctx?.drawImage(img, 0, 0, dimensions.width, dimensions.height)
      canvas.convertToBlob({ type: 'image/png' })
        .then(blob => blob.arrayBuffer())
        .then(resolve)
        .catch(reject)
    }
    img.onerror = reject
    img.src = `data:image/svg+xml;base64,${btoa(svgText)}`
  })
}

async function convertAnimatedSVGtoMP4(svgText: string): Promise<ArrayBuffer> {
  const dimensions = getSVGDimensions(svgText)
  const ffmpeg = new FFmpeg()

  // Load FFmpeg
  await ffmpeg.load({
    coreURL: await toBlobURL(`/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`/ffmpeg-core.wasm`, 'application/wasm'),
  })

  // Create a temporary file with the SVG content
  await ffmpeg.writeFile('input.svg', svgText)

  // Convert SVG to PNG sequence with original dimensions
  await ffmpeg.exec([
    '-i', 'input.svg',
    '-vf', `scale=${dimensions.width}:${dimensions.height},fps=30`,
    'frame_%d.png'
  ])

  // Convert PNG sequence to MP4
  await ffmpeg.exec([
    '-framerate', '30',
    '-i', 'frame_%d.png',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    'output.mp4'
  ])

  // Read the output file
  const data = await ffmpeg.readFile('output.mp4')
  return data
}

async function isAnimatedGIF(buffer: ArrayBuffer): Promise<boolean> {
  // Check if the GIF has multiple frames by looking for the Graphic Control Extension
  const view = new Uint8Array(buffer)
  let pos = 13 // Skip header
  while (pos < view.length) {
    if (view[pos] === 0x21 && view[pos + 1] === 0xF9) {
      return true // Found Graphic Control Extension
    }
    pos++
  }
  return false
}

async function convertGIFtoPNG(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const dimensions = getGIFDimensions(buffer)
  const img = new Image()
  const canvas = new OffscreenCanvas(dimensions.width, dimensions.height)
  const ctx = canvas.getContext('2d')

  return new Promise((resolve, reject) => {
    img.onload = () => {
      ctx?.drawImage(img, 0, 0, dimensions.width, dimensions.height)
      canvas.convertToBlob({ type: 'image/png' })
        .then(blob => blob.arrayBuffer())
        .then(resolve)
        .catch(reject)
    }
    img.onerror = reject
    img.src = `data:image/gif;base64,${btoa(String.fromCharCode(...new Uint8Array(buffer)))}`
  })
}

async function convertGIFtoMP4(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const dimensions = getGIFDimensions(buffer)
  const ffmpeg = new FFmpeg()

  // Load FFmpeg
  await ffmpeg.load({
    coreURL: await toBlobURL(`/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`/ffmpeg-core.wasm`, 'application/wasm'),
  })

  // Write the GIF file
  await ffmpeg.writeFile('input.gif', new Uint8Array(buffer))

  // Convert GIF to MP4 with original dimensions
  await ffmpeg.exec([
    '-i', 'input.gif',
    '-movflags', 'faststart',
    '-pix_fmt', 'yuv420p',
    '-vf', `scale=${dimensions.width}:${dimensions.height}`,
    'output.mp4'
  ])

  // Read the output file
  const data = await ffmpeg.readFile('output.mp4')
  return data
}