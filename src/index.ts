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

type FileData = string | Uint8Array | ArrayBuffer

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Handle FFmpeg core files requests
    const url = new URL(request.url)
    if (url.pathname === '/ffmpeg-core.js' || url.pathname === '/ffmpeg-core.wasm') {
      const response = await fetch(`https://unpkg.com/@ffmpeg/core@0.12.4/dist${url.pathname}`)
      if (!response.ok) {
        return new Response('FFmpeg core file not found', { status: 404 })
      }
      const data = await response.arrayBuffer()
      return new Response(data, {
        headers: {
          'Content-Type': url.pathname.endsWith('.js') ? 'text/javascript' : 'application/wasm',
          'Access-Control-Allow-Origin': '*'
        }
      })
    }

    // Only allow POST requests for image conversion
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 })
    }

    try {
      // Get the data from the request
      const formData = await request.formData()
      const file = formData.get('file') as File
      const imageUrl = formData.get('url') as string

      if (!file && !imageUrl) {
        return new Response('No file or URL provided', { status: 400 })
      }

      let fileBuffer: ArrayBuffer
      let fileType: string

      if (imageUrl) {
        // Fetch the image from the URL
        const response = await fetch(imageUrl)
        if (!response.ok) {
          return new Response('Failed to fetch image from URL', { status: response.status })
        }
        fileBuffer = await response.arrayBuffer()
        fileType = response.headers.get('content-type') || 'image/gif'
      } else {
        // Use the uploaded file
        fileBuffer = await file.arrayBuffer()
        fileType = file.type
      }

      // Check file type
      if (!['image/svg+xml', 'image/gif'].includes(fileType)) {
        return new Response('Invalid file type. Only SVG and GIF files are supported.', { status: 400 })
      }

      // For SVG files, check if animated and convert accordingly
      if (fileType === 'image/svg+xml') {
        const svgText = new TextDecoder().decode(fileBuffer)
        const isAnimated = isAnimatedSVG(svgText)

        if (isAnimated) {
          const mp4 = await convertAnimatedSVGtoMP4(svgText)
          return new Response(mp4, {
            headers: {
              'Content-Type': 'video/mp4',
              'Content-Disposition': 'attachment; filename="converted.mp4"',
              'Access-Control-Allow-Origin': '*'
            }
          })
        } else {
          const png = await convertSVGtoPNG(svgText)
          return new Response(png, {
            headers: {
              'Content-Type': 'image/png',
              'Content-Disposition': 'attachment; filename="converted.png"',
              'Access-Control-Allow-Origin': '*'
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
              'Content-Disposition': 'attachment; filename="converted.mp4"',
              'Access-Control-Allow-Origin': '*'
            }
          })
        } else {
          const png = await convertGIFtoPNG(fileBuffer)
          return new Response(png, {
            headers: {
              'Content-Type': 'image/png',
              'Content-Disposition': 'attachment; filename="converted.png"',
              'Access-Control-Allow-Origin': '*'
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

function getSVGDimensions(svgText: string): Dimensions {
  // Default dimensions
  let width = 800
  let height = 600

  // Try to find viewBox
  const viewBoxMatch = svgText.match(/viewBox="([^"]+)"/)
  if (viewBoxMatch) {
    const [, viewBox] = viewBoxMatch
    const [, , w, h] = viewBox.split(' ').map(Number)
    width = w
    height = h
  } else {
    // Try to find width and height attributes
    const widthMatch = svgText.match(/width="([^"]+)"/)
    const heightMatch = svgText.match(/height="([^"]+)"/)

    if (widthMatch) {
      width = parseFloat(widthMatch[1])
    }
    if (heightMatch) {
      height = parseFloat(heightMatch[1])
    }
  }

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
  const ffmpeg = new FFmpeg()

  // Load FFmpeg
  await ffmpeg.load({
    coreURL: await toBlobURL(`/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`/ffmpeg-core.wasm`, 'application/wasm'),
  })

  // Create a temporary file with the SVG content
  await ffmpeg.writeFile('input.svg', svgText)

  // Convert SVG to PNG
  await ffmpeg.exec([
    '-i', 'input.svg',
    '-vf', `scale=${dimensions.width}:${dimensions.height}`,
    'output.png'
  ])

  // Read the output file
  const data = await ffmpeg.readFile('output.png') as ArrayBuffer
  return data
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

  // Convert SVG to PNG sequence
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
  const data = await ffmpeg.readFile('output.mp4') as ArrayBuffer
  return data
}

async function convertGIFtoPNG(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const dimensions = getGIFDimensions(buffer)
  const ffmpeg = new FFmpeg()

  // Load FFmpeg
  await ffmpeg.load({
    coreURL: await toBlobURL(`/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`/ffmpeg-core.wasm`, 'application/wasm'),
  })

  // Write the GIF file
  await ffmpeg.writeFile('input.gif', new Uint8Array(buffer))

  // Convert GIF to PNG
  await ffmpeg.exec([
    '-i', 'input.gif',
    '-vf', `scale=${dimensions.width}:${dimensions.height}`,
    'output.png'
  ])

  // Read the output file
  const data = await ffmpeg.readFile('output.png') as ArrayBuffer
  return data
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

  // Convert GIF to MP4
  await ffmpeg.exec([
    '-i', 'input.gif',
    '-movflags', 'faststart',
    '-pix_fmt', 'yuv420p',
    '-vf', `scale=${dimensions.width}:${dimensions.height}`,
    'output.mp4'
  ])

  // Read the output file
  const data = await ffmpeg.readFile('output.mp4') as ArrayBuffer
  return data
}

function isAnimatedSVG(svgText: string): boolean {
  // Check for SMIL animation elements
  const animationElements = ['<animate', '<animateTransform', '<animateMotion', '<set']
  return animationElements.some(element => svgText.includes(element))
}

async function isAnimatedGIF(buffer: ArrayBuffer): Promise<boolean> {
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