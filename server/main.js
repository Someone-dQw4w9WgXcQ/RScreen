"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// downscale
const screenShotResolutionX = 1920 / 5;
const screenShotResolutionY = 1080 / 5;
const videoResolution = 288; //288p
const videoFPS = 10;
const express_1 = __importDefault(require("express"));
const screenshot_desktop_1 = __importDefault(require("screenshot-desktop"));
const sharp_1 = __importDefault(require("sharp"));
const axios_1 = __importDefault(require("axios"));
const fluent_ffmpeg_1 = __importDefault(require("fluent-ffmpeg"));
const zlib_1 = __importDefault(require("zlib"));
const mime_1 = __importDefault(require("mime"));
const ytdl_core_1 = __importDefault(require("ytdl-core"));
const stream_1 = require("stream");
const app = (0, express_1.default)();
function takeScreenshot() {
    return __awaiter(this, void 0, void 0, function* () {
        const imgBuffer = yield (0, screenshot_desktop_1.default)({ format: "png" });
        const resizedImgBuffer = yield (0, sharp_1.default)(imgBuffer)
            .resize(screenShotResolutionX, screenShotResolutionY)
            .toBuffer();
        return resizedImgBuffer;
    });
}
// Defer to return response immediately
let newestScreenshot;
let isTakingScreenshot = true;
function updateScreenshot() {
    takeScreenshot().then((screenshot) => {
        isTakingScreenshot = false;
        newestScreenshot = screenshot;
    });
}
updateScreenshot();
app.get("/screenshot", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    res.set("Content-Type", "image/png");
    res.send(newestScreenshot);
    if (!isTakingScreenshot)
        updateScreenshot();
}));
function getExtensionOfUrl(url) {
    return __awaiter(this, void 0, void 0, function* () {
        const response = yield axios_1.default.head(url);
        const contentType = response.headers["content-type"];
        const extension = mime_1.default.getExtension(contentType);
        return extension;
    });
}
function validateExtension(url) {
    return __awaiter(this, void 0, void 0, function* () {
        const extension = yield getExtensionOfUrl(url);
        if (extension != "mp4" && extension != "webm") {
            throw Error(`Unsupported format ${extension}`);
        }
        return extension;
    });
}
app.get("/getExtension", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const url = req.query.url;
    if (!url) {
        return res.status(400).send("Missing \"url\" parameter");
    }
    res.send(yield getExtensionOfUrl(url));
}));
app.get("/youtube", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const url = req.query.url;
    if (!url) {
        return res.status(400).send("Missing \"url\" parameter");
    }
    res.set("Content-Type", "video/mp4");
    (0, ytdl_core_1.default)(url.toString()).pipe(res);
}));
// TODO: investigate why frames are being dropped
app.get("/frame", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const url = req.query.url;
    // Check if the URL parameter is present in the request
    if (!url) {
        return res.status(400).send("Missing \"url\" parameter");
    }
    const onError = (error) => {
        console.error(error);
        res.status(500).send("Error converting");
    };
    const extension = yield validateExtension(url);
    console.time("Get frames");
    let framesNeeded = 0;
    let framesDone = 0;
    const frames = [];
    const response = yield (0, axios_1.default)({
        url: url.toString(),
        method: "GET",
        responseType: "stream"
    });
    const ffmpegStream = new stream_1.Stream.PassThrough();
    const ffprobeStream = new stream_1.Stream.PassThrough();
    let downloadSizeInBytes = 0;
    response.data.on("data", (buffer) => {
        downloadSizeInBytes += buffer.byteLength;
        ffmpegStream.write(buffer);
        ffprobeStream.write(buffer);
    });
    response.data.on("end", (buffer) => {
        ffmpegStream.end(buffer);
        ffprobeStream.end(buffer);
        console.log("Wrote all");
    });
    // `as any` because ffmpeg.ffprobe expects a string, for some reason?
    let error, data;
    yield new Promise((resolve) => {
        fluent_ffmpeg_1.default.ffprobe(ffprobeStream, (_error, _data) => {
            error = _error;
            data = _data;
            resolve(null);
        });
    });
    if (error) {
        onError(error);
    }
    const videoStream = data.streams.find(stream => stream.codec_type === "video");
    const originalHeight = videoStream.height;
    const originalWidth = videoStream.width;
    let resultFps;
    let resultHeight;
    let resultWidth;
    if (originalHeight > videoResolution) {
        resultWidth = Math.floor(originalWidth / (originalHeight / videoResolution));
        resultHeight = videoResolution;
    }
    else {
        resultHeight = originalHeight;
        resultWidth = originalWidth;
    }
    console.log(`Dimensions: ${originalWidth}x${originalHeight} -> ${resultWidth}x${resultHeight}`);
    const fpsString = videoStream.r_frame_rate;
    const [numerator, denominator] = fpsString.split("/");
    const originalFps = parseFloat(numerator) / parseFloat(denominator);
    if (originalFps > videoFPS) {
        resultFps = videoFPS;
    }
    else {
        resultFps = originalFps;
    }
    console.log("Original FPS:", originalFps);
    const onGotFrames = () => {
        console.log("frames", framesNeeded, framesDone, frames.length);
        console.timeEnd("Get frames");
        console.time("Compress");
        const metadata = Buffer.alloc(8 + 2 + 2);
        metadata.write(resultFps.toString(), 0);
        metadata.writeUInt16BE(resultWidth, 8);
        metadata.writeUInt16BE(resultHeight, 10);
        frames.push(metadata);
        console.log(frames.length);
        const framesConcat = Buffer.concat(frames);
        const compressed = zlib_1.default.deflateSync(framesConcat); // separate with a character that isn't used by the rgb
        console.log(downloadSizeInBytes / 1e6, "->", framesConcat.byteLength / 1e6, "->", compressed.byteLength / 1e6, "megabytes");
        console.timeEnd("Compress");
        res.send(compressed);
    };
    let ffmpegFinished = false;
    const command = (0, fluent_ffmpeg_1.default)()
        .input(ffmpegStream)
        .inputFormat(extension)
        .fps(resultFps)
        .size(`?x${resultHeight}`)
        .outputFormat("image2pipe")
        .on("end", () => {
        console.log("ended");
        ffmpegFinished = true;
        if (framesDone === framesNeeded)
            onGotFrames();
    })
        .on("error", onError);
    const ffmpegOut = new stream_1.Stream.Writable({
        write(image, encoding, callback) {
            let thisFrameIndex = framesNeeded;
            framesNeeded++;
            (0, sharp_1.default)(image)
                .removeAlpha()
                .raw()
                .toBuffer({ resolveWithObject: true }).then(({ data, info }) => {
                let prevR = data[0];
                let prevG = data[1];
                let prevB = data[2];
                const filtered = new Uint8Array(data.length);
                filtered[0] = prevR;
                filtered[1] = prevG;
                filtered[2] = prevB;
                for (let i = 3; i < data.length; i += 3) {
                    const r = data[i];
                    const g = data[i + 1];
                    const b = data[i + 2];
                    filtered[i] = (r - prevR) & 255;
                    filtered[i + 1] = (g - prevG) & 255;
                    filtered[i + 2] = (b - prevB) & 255;
                    prevR = r;
                    prevG = g;
                    prevB = b;
                }
                frames[thisFrameIndex] = filtered;
                framesDone++;
                if (ffmpegFinished && framesDone === framesNeeded)
                    onGotFrames();
            });
            callback();
        }
    });
    command.pipe(ffmpegOut, { end: true });
}));
app.listen(3000, () => {
    console.log("Server is running on http://localhost:3000");
});
