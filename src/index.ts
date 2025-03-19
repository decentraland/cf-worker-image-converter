/// <reference types="@cloudflare/workers-types" />

import { Env } from './types'

interface CloudinaryResponse {
  secure_url: string
  format: string
  resource_type: string
}

async function uploadToCloudinary(file: ArrayBuffer, format: string, env: Env): Promise<CloudinaryResponse> {
  const formData = new FormData()
  const blob = new Blob([file], { type: `image/${format}` })
  formData.append('file', blob, `file.${format}`)
  formData.append('upload_preset', 'ml_default')


  const timestamp = Math.floor(Date.now() / 1000)
  const params = {
    timestamp,
    upload_preset: 'ml_default',
    api_key: env.CLOUDINARY_API_KEY,
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

  return response.json()
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

    const uploadResult = await uploadToCloudinary(fileBuffer, format, env)

    // Fetch the converted image
    const imageResponse = await fetch(uploadResult.secure_url)
    const imageBuffer = await imageResponse.arrayBuffer()

    // Return the image directly
    return new Response(imageBuffer, {
      headers: {
        'Content-Type': uploadResult.resource_type === 'video' ? 'video/mp4' : 'image/png',
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

        const uploadResult = await uploadToCloudinary(fileBuffer, format, env)

        return new Response(JSON.stringify({
          url: uploadResult.secure_url,
          format: uploadResult.format,
          resource_type: uploadResult.resource_type
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
