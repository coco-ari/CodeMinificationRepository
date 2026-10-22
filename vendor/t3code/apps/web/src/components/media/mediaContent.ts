/** Resolves web references without inheriting the desktop renderer's custom app scheme. */
export function resolveProtocolRelativeMediaUrl(src: string): string {
  if (!src.startsWith("//")) return src;
  const protocol =
    typeof window !== "undefined" && window.location.protocol === "http:" ? "http:" : "https:";
  return `${protocol}${src}`;
}

async function readMediaBlob(src: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(src);
  } catch (cause) {
    throw new Error(
      "无法获取文件。主机可能阻止了浏览器访问（CORS），或连接不可用。",
      { cause },
    );
  }
  if (!response.ok) throw new Error(`无法获取文件（HTTP ${response.status}）。`);
  const blob = await response.blob();
  if (blob.type.split(";", 1)[0] === "text/html") {
    throw new Error("此链接返回了网页，无法作为媒体预览。请打开原始 URL。");
  }
  return blob;
}

export async function downloadMedia(src: string, name: string): Promise<void> {
  const url = URL.createObjectURL(await readMediaBlob(src));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

export async function readMediaPng(src: string): Promise<Blob> {
  const blob = await readMediaBlob(src);
  if (blob.type.split(";", 1)[0] === "image/png") return blob;

  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;
  try {
    try {
      await image.decode();
    } catch (cause) {
      throw new Error(
        "浏览器无法解码并复制此图片，请尝试保存。",
        {
          cause,
        },
      );
    }
    const { naturalWidth: width, naturalHeight: height } = image;
    if (width <= 0 || height <= 0 || width * height > 64_000_000) {
      throw new Error(
        "图片过大或尺寸无效，请尝试保存。",
      );
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("此浏览器不支持复制图片。");
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (png) =>
          png ? resolve(png) : reject(new Error("无法将图片转换为 PNG。")),
        "image/png",
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
