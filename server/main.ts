// downscale
const screenShotResolutionX = 1920 / 5
const screenShotResolutionY = 1080 / 5

const videoResolution = 288 //288p
const videoFPS = 10

import express from "express"
import screenshot from "screenshot-desktop"
import sharp from "sharp"

import axios from "axios"
import ffmpeg from "fluent-ffmpeg"
import zlib from "zlib"
import mime from "mime"
import youtube from "ytdl-core"
import { Stream } from "stream"

const app = express()

async function takeScreenshot() {
	const imgBuffer = await screenshot({ format: "png" })
	const resizedImgBuffer = await sharp(imgBuffer)
		.resize(screenShotResolutionX, screenShotResolutionY)
		.toBuffer()
	return resizedImgBuffer
}

// Defer to return response immediately
let newestScreenshot
let isTakingScreenshot = true
function updateScreenshot() {
	takeScreenshot().then((screenshot) => {
		isTakingScreenshot = false
		newestScreenshot = screenshot
	})
}
updateScreenshot()

app.get("/screenshot", async (req, res) => {
	res.set("Content-Type", "image/png")
	res.send(newestScreenshot)
	if (!isTakingScreenshot) updateScreenshot()
})

async function getExtensionOfUrl(url) {
	const response = await axios.head(url)
	const contentType = response.headers["content-type"]
	const extension = mime.getExtension(contentType)
	return extension
}

async function validateExtension(url) {
	const extension = await getExtensionOfUrl(url)
	if (extension != "mp4" && extension != "webm") {
		throw Error(`Unsupported format ${extension}`)
	}
	return extension
}

app.get("/getExtension", async (req, res) => {
	const url = req.query.url
	if (!url) {
		return res.status(400).send("Missing \"url\" parameter")
	}

	res.send(await getExtensionOfUrl(url))
})

app.get("/youtube", async (req, res) => {
	const url = req.query.url
	if (!url) {
		return res.status(400).send("Missing \"url\" parameter")
	}

	res.set("Content-Type", "video/mp4")
	youtube(url.toString()).pipe(res)
})

// TODO: investigate why frames are being dropped

app.get("/frame", async (req, res) => {
	const url = req.query.url

	// Check if the URL parameter is present in the request
	if (!url) {
		return res.status(400).send("Missing \"url\" parameter")
	}

	const onError = (error) => {
		console.error(error)
		res.status(500).send("Error converting")
	}

	const extension = await validateExtension(url)

	console.time("Get frames")

	let framesNeeded = 0
	let framesDone = 0

	const frames = []

	const response = await axios({
		url: url.toString(),
		method: "GET",
		responseType: "stream"
	})

	const ffmpegStream = new Stream.PassThrough()
	const ffprobeStream = new Stream.PassThrough()
	let downloadSizeInBytes = 0
	response.data.on("data", (buffer) => {
		downloadSizeInBytes += buffer.byteLength
		ffmpegStream.write(buffer)
		ffprobeStream.write(buffer)
	})

	response.data.on("end", (buffer) => {
		ffmpegStream.end(buffer)
		ffprobeStream.end(buffer)
		console.log("Wrote all")
	})

	// `as any` because ffmpeg.ffprobe expects a string, for some reason?
	let error, data
	await new Promise((resolve) => {
		ffmpeg.ffprobe(ffprobeStream as any, (_error, _data) => {
			error = _error
			data = _data
			resolve(null)
		})
	})

	if (error) {
		onError(error)
	}

	const videoStream = data.streams.find(stream => stream.codec_type === "video")

	const originalHeight = videoStream.height

	const originalWidth = videoStream.width

	let resultFps
	let resultHeight
	let resultWidth

	if (originalHeight > videoResolution) {
		resultWidth = Math.floor(originalWidth / (originalHeight / videoResolution))
		resultHeight = videoResolution
	} else {
		resultHeight = originalHeight
		resultWidth = originalWidth
	}

	console.log(`Dimensions: ${originalWidth}x${originalHeight} -> ${resultWidth}x${resultHeight}`)

	const fpsString = videoStream.r_frame_rate
	const [numerator, denominator] = fpsString.split("/")
	const originalFps = parseFloat(numerator) / parseFloat(denominator)
	if (originalFps > videoFPS) {
		resultFps = videoFPS
	} else {
		resultFps = originalFps
	}
	console.log("Original FPS:", originalFps)

	const onGotFrames = () => {
		console.log("frames", framesNeeded, framesDone, frames.length)

		console.timeEnd("Get frames")

		console.time("Compress")

		const metadata = Buffer.alloc(8 + 2 + 2)
		metadata.write(resultFps.toString(), 0)
		metadata.writeUInt16BE(resultWidth, 8)
		metadata.writeUInt16BE(resultHeight, 10)
		frames.push(metadata)
		console.log(frames.length)

		const framesConcat = Buffer.concat(frames)

		const compressed = zlib.deflateSync(framesConcat) // separate with a character that isn't used by the rgb
		console.log(downloadSizeInBytes / 1e6, "->", framesConcat.byteLength / 1e6, "->", compressed.byteLength / 1e6, "megabytes")

		console.timeEnd("Compress")

		res.send(compressed)
	}

	let ffmpegFinished = false

	const command = ffmpeg()
		.input(ffmpegStream)
		.inputFormat(extension)
		.fps(resultFps)
		.size(`?x${resultHeight}`)
		.outputFormat("image2pipe")
		.on("end", () => {
			console.log("ended")
			ffmpegFinished = true
			if (framesDone === framesNeeded) onGotFrames()
		})
		.on("error", onError)

	const ffmpegOut = new Stream.Writable({
		write(image, encoding, callback) {
			let thisFrameIndex = framesNeeded
			framesNeeded++

			sharp(image)
				.removeAlpha()
				.raw()
				.toBuffer({ resolveWithObject: true }).then(({ data, info }) => {
					let prevR = data[0]
					let prevG = data[1]
					let prevB = data[2]

					const filtered = new Uint8Array(data.length)

					filtered[0] = prevR
					filtered[1] = prevG
					filtered[2] = prevB

					for (let i = 3; i < data.length; i += 3) {
						const r = data[i]
						const g = data[i + 1]
						const b = data[i + 2]

						filtered[i] = (r - prevR) & 255
						filtered[i + 1] = (g - prevG) & 255
						filtered[i + 2] = (b - prevB) & 255

						prevR = r
						prevG = g
						prevB = b
					}
					frames[thisFrameIndex] = filtered

					framesDone++
					if (ffmpegFinished && framesDone === framesNeeded) onGotFrames()
				})

			callback()
		}
	})
	command.pipe(ffmpegOut, { end: true })
})

app.listen(3000, () => {
	console.log("Server is running on http://localhost:3000")
})