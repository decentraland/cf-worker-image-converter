/// <reference types="@cloudflare/workers-types" />

import { Env } from './types'

interface CloudinaryResponse {
  secure_url: string
  format: string
  resource_type: string
}

interface CloudinaryUploadResult {
  secure_url: string
  public_id: string
  format: string
  resource_type: string
}

function isAnimatedSVG(svgContent: string): boolean {
  const animationElements = [
    '<animate',
    '<animateMotion',
    '<animateTransform',
    '<set'
  ]
  return animationElements.some(element => svgContent.includes(element))
}

function isAnimatedGIF(buffer: ArrayBuffer): boolean {
  const view = new Uint8Array(buffer)
  let frames = 0
  let pos = 0

  // Check GIF header
  if (view[0] !== 0x47 || view[1] !== 0x49 || view[2] !== 0x46) {
    return false
  }

  pos += 13 // Skip header and logical screen descriptor

  while (pos < view.length) {
    if (view[pos] === 0x21 && view[pos + 1] === 0xF9) {
      frames++
      if (frames > 1) return true
      pos += 8
    } else if (view[pos] === 0x2C) {
      pos += 11
    } else {
      pos++
    }
  }

  return false
}

async function uploadToCloudinary(file: ArrayBuffer, format: string, isAnimated: boolean, env: Env): Promise<CloudinaryResponse> {
  const formData = new FormData()
  const blob = new Blob([file], { type: `image/${format}` })
  formData.append('file', blob, `file.${format}`)
  formData.append('upload_preset', 'ml_default')
  formData.append('resource_type', 'auto')

  const timestamp = Math.floor(Date.now() / 1000)
  const params = {
    timestamp,
    upload_preset: 'ml_default',
    api_key: env.CLOUDINARY_API_KEY,
    resource_type: 'auto'
  }

  const signature = await generateSignature(params, env)

  const url = `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/auto/upload`
  const response = await fetch(url, {
    method: 'POST',
    body: formData,
    headers: {
      'X-Timestamp': timestamp.toString(),
      'X-Signature': signature,
      'X-API-Key': env.CLOUDINARY_API_KEY,
    },
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Cloudinary upload failed: ${response.statusText} - ${errorText}`)
  }

  const result = await response.json() as CloudinaryUploadResult

  // Si es animado, convertir a MP4, si no, a PNG
  if (isAnimated) {
    return {
      secure_url: result.secure_url.replace(/\.[^/.]+$/, '.mp4'),
      format: 'mp4',
      resource_type: 'video'
    }
  } else {
    return {
      secure_url: result.secure_url.replace(/\.[^/.]+$/, '.png'),
      format: 'png',
      resource_type: 'image'
    }
  }
}

async function generateSignature(params: Record<string, any>, env: Env): Promise<string> {
  // Sort parameters alphabetically
  const sortedParams = Object.keys(params)
    .sort()
    .reduce((acc: Record<string, any>, key) => {
      acc[key] = params[key]
      return acc
    }, {})

  // Create string to sign
  const stringToSign = Object.entries(sortedParams)
    .map(([key, value]) => `${key}=${value}`)
    .join('&') + env.CLOUDINARY_API_SECRET

  // Generate SHA-1 hash
  const encoder = new TextEncoder()
  const data = encoder.encode(stringToSign)
  const hashBuffer = await crypto.subtle.digest('SHA-1', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

async function handleImageConversion(url: string, env: Env): Promise<Response> {
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error('Failed to fetch image from URL')

    const fileBuffer = await response.arrayBuffer()
    const format = url.split('.').pop()?.toLowerCase() || ''

    if (!['svg', 'gif'].includes(format)) {
      return new Response('Unsupported file format', { status: 400 })
    }

    // Check if the image is animated
    let isAnimated = false
    if (format === 'svg') {
      const svgText = new TextDecoder().decode(fileBuffer)
      isAnimated = isAnimatedSVG(svgText)
    } else if (format === 'gif') {
      isAnimated = isAnimatedGIF(fileBuffer)
    }

    const uploadResult = await uploadToCloudinary(fileBuffer, format, isAnimated, env)

    // Fetch the converted image/video
    const convertedResponse = await fetch(uploadResult.secure_url)
    const convertedBuffer = await convertedResponse.arrayBuffer()

    // Return the converted file directly
    return new Response(convertedBuffer, {
      headers: {
        'Content-Type': isAnimated ? 'video/mp4' : 'image/png',
        'Access-Control-Allow-Origin': '*',
        'Content-Disposition': `inline; filename="converted.${isAnimated ? 'mp4' : 'png'}"`,
      },
    })
  } catch (error: unknown) {
    console.error('Error:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    })
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      })
    }

    // Handle GET requests with URL parameter
    if (request.method === 'GET') {
      const url = new URL(request.url)
      const imageUrl = url.searchParams.get('url')

      if (imageUrl) {
        return handleImageConversion(imageUrl, env)
      }

      return new Response('Missing URL parameter', { status: 400 })
    }

    // Handle POST requests
    if (request.method === 'POST') {
      try {
        const formData = await request.formData()
        let fileBuffer: ArrayBuffer
        let format: string

        if (formData.has('url')) {
          const url = formData.get('url') as string
          const response = await fetch(url)
          if (!response.ok) throw new Error('Failed to fetch image from URL')
          fileBuffer = await response.arrayBuffer()
          format = url.split('.').pop()?.toLowerCase() || ''
        } else if (formData.has('file')) {
          const file = formData.get('file') as File
          fileBuffer = await file.arrayBuffer()
          format = file.name.split('.').pop()?.toLowerCase() || ''
        } else {
          return new Response('No file or URL provided', { status: 400 })
        }

        if (!['svg', 'gif'].includes(format)) {
          return new Response('Unsupported file format', { status: 400 })
        }

        // Check if the image is animated
        let isAnimated = false
        if (format === 'svg') {
          const svgText = new TextDecoder().decode(fileBuffer)
          isAnimated = isAnimatedSVG(svgText)
        } else if (format === 'gif') {
          isAnimated = isAnimatedGIF(fileBuffer)
        }

        const uploadResult = await uploadToCloudinary(fileBuffer, format, isAnimated, env)

        return new Response(JSON.stringify({
          url: uploadResult.secure_url,
          format: isAnimated ? 'mp4' : 'png',
          resource_type: isAnimated ? 'video' : 'image'
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        })
      } catch (error: unknown) {
        console.error('Error:', error)
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'
        return new Response(JSON.stringify({ error: errorMessage }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        })
      }
    }

    return new Response('Method not allowed', { status: 405 })
  },
}
