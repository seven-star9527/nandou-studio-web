using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;
using Image = SixLabors.ImageSharp.Image;

namespace SwarmUI.WebAPI;

/// <summary>Project-local APIMart adapter. Paid submissions are never retried.</summary>
public static partial class StudioCloudAPI
{
    private static readonly HttpClient Client = new(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(90) };
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> Locks = new();
    private static string Root => Environment.GetEnvironmentVariable("QWEN_STUDIO_ROOT") ?? Path.GetFullPath("../..");
    private static JObject Capabilities => JObject.Parse(File.ReadAllText(Path.Combine(Root, "server/SwarmUI/Data/StudioCloudModels.json")));

    public static void Register()
    {
        API.RegisterAPICall(GetStudioCloudCapabilities, false, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(GetStudioCloudAccount, false, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(GetStudioCloudQuote, false, Permissions.FundamentalGenerateTabAccess);
        API.RegisterAPICall(SubmitStudioCloudImage, true, Permissions.BasicImageGeneration);
        API.RegisterAPICall(GetStudioCloudTask, false, Permissions.ViewImageHistory);
        API.RegisterAPICall(ListStudioCloudTasks, false, Permissions.ViewImageHistory);
    }

    private static string Key()
    {
        string key = Environment.GetEnvironmentVariable("APIMART_API_KEY");
        if (!string.IsNullOrWhiteSpace(key)) return key.Trim();
        string path = Path.Combine(Root, ".env");
        if (!File.Exists(path)) return "";
        foreach (string line in File.ReadLines(path))
        {
            Match match = Regex.Match(line, @"^\s*(?:export\s+)?APIMART_API_KEY\s*=\s*(.*)$");
            if (!match.Success) continue;
            string value = match.Groups[1].Value.Trim();
            if (value.Length >= 2 && (value[0] == '\"' && value[^1] == '\"' || value[0] == '\'' && value[^1] == '\'')) value = value[1..^1];
            return value;
        }
        return "";
    }

    public static Task<JObject> GetStudioCloudCapabilities(Session session)
    {
        JObject caps = Capabilities;
        caps["provider"] = "apimart";
        caps["configured"] = Key().Length > 0;
        string models = Path.Combine(Root, "models/qwen-image-2.1");
        bool commonReady = File.Exists(Path.Combine(models, "text_encoders/qwen3vl_8b_int8_convrot.safetensors")) && File.Exists(Path.Combine(models, "vae/qwen_image_2.1_vae_bf16.safetensors"));
        caps["localReadiness"] = new JObject
        {
            ["qwen_image_2.1_int8_convrot.safetensors"] = commonReady && File.Exists(Path.Combine(models, "diffusion_models/qwen_image_2.1_int8_convrot.safetensors")),
            ["qwen_image_2.1_turbo_int8_convrot.safetensors"] = commonReady && File.Exists(Path.Combine(models, "diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors"))
        };
        return Task.FromResult(caps);
    }

    private static JObject Error(string message, string id = "cloud_invalid_request") => new() { ["error"] = message, ["error_id"] = id };
    private static string UserFolder(string user) => Path.Combine(Root, "server/SwarmUI/Data/StudioCloudTasks", Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(user)))[..24]);
    private static string RecordPath(string user, string id) => Path.Combine(UserFolder(user), id + ".json");
    private static string Id(string raw) => Guid.TryParseExact(raw, "D", out Guid id) ? id.ToString("D") : throw new ArgumentException("request_id 必须是 UUID");
    private static SemaphoreSlim Lock(string user, string id) => Locks.GetOrAdd(user + ":" + id, _ => new(1, 1));
    private static void Save(string user, JObject record)
    {
        string path = RecordPath(user, (string)record["request_id"]);
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        string temp = path + ".tmp";
        byte[] bytes = Encoding.UTF8.GetBytes(record.ToString(Formatting.Indented));
        using (var file = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            file.Write(bytes);
            file.Flush(true);
        }
        File.Move(temp, path, true);
    }
    private static JObject Read(string user, string id) => File.Exists(RecordPath(user, id)) ? JObject.Parse(File.ReadAllText(RecordPath(user, id))) : null;
    private static JObject Public(JObject record)
    {
        JObject result = (JObject)record.DeepClone();
        result.Remove("fingerprint");
        return result;
    }

    public static string RequestFingerprint(JObject input)
    {
        static JToken Ordered(JToken token) => token switch
        {
            JObject obj => new JObject(obj.Properties().Where(p => p.Name != "session_id").OrderBy(p => p.Name, StringComparer.Ordinal).Select(p => new JProperty(p.Name, Ordered(p.Value)))),
            JArray array => new JArray(array.Select(Ordered)),
            _ => token.DeepClone()
        };
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Ordered(input).ToString(Formatting.None))));
    }

    /// <summary>Validate provider-specific request before uploads or paid submission.</summary>
    public static JObject ValidateRequest(JObject input, JObject caps)
    {
        string model = (string)input["model"], operation = (string)input["operation"];
        JObject cap = caps["models"].OfType<JObject>().FirstOrDefault(c => (string)c["id"] == model) ?? throw new ArgumentException("未知云模型");
        if (operation is not ("generate" or "edit") || !cap["operations"].Values<string>().Contains(operation)) throw new ArgumentException("模型不支持此操作");
        string prompt = ((string)input["prompt"] ?? "").Trim();
        if (prompt.Length is < 1 or > 30000) throw new ArgumentException("提示词长度应为 1～30000 字符");
        if (input["n"]?.Type != JTokenType.Integer) throw new ArgumentException("生成数量必须是整数");
        int count = (int)input["n"];
        if (count < 1 || count > (int)cap["maxImages"]) throw new ArgumentException("生成数量超出模型范围");
        string resolution = ((string)input["resolution"] ?? "1K").ToUpperInvariant();
        if (!cap["resolutions"].Values<string>().Contains(resolution)) throw new ArgumentException("分辨率不受模型支持");
        string size = (string)input["size"] ?? "auto";
        if (!cap["ratios"].Values<string>().Contains(size))
        {
            JObject rules = cap["exactSize"] as JObject;
            Match match = Regex.Match(size, @"^(\d{2,5})x(\d{2,5})$");
            if (rules is null || rules.Value<bool?>("supported") == false || !match.Success) throw new ArgumentException("比例或精确尺寸不受模型支持");
            int width = int.Parse(match.Groups[1].Value), height = int.Parse(match.Groups[2].Value);
            long pixels = (long)width * height;
            if (width % (int)rules["multiple"] != 0 || height % (int)rules["multiple"] != 0 || Math.Max(width, height) > (int)rules["maxSide"] || pixels < (long)rules["minPixels"] || pixels > (long)rules["maxPixels"] || (double)Math.Max(width, height) / Math.Min(width, height) > (double)rules["maxAspect"]) throw new ArgumentException("精确尺寸超出模型规则");
        }
        JArray refs = input["reference_images"] as JArray ?? [];
        int maxRefs = Math.Min(cap.Value<int?>("maxReferences") ?? int.MaxValue, cap.Value<int>("appMaxReferences"));
        if (refs.Count > maxRefs || operation == "edit" && refs.Count == 0) throw new ArgumentException("参考图数量不符合此操作要求");
        foreach (JToken image in refs) DecodeReference(image.Value<string>());
        JObject body = new() { ["model"] = model, ["prompt"] = prompt, ["size"] = size, ["resolution"] = model.StartsWith("gpt-") ? resolution.ToLowerInvariant() : resolution, ["n"] = count };
        string quality = (string)input["quality"];
        if (!string.IsNullOrEmpty(quality))
        {
            if (cap["qualities"] is not JArray qualityChoices || !qualityChoices.Values<string>().Contains(quality)) throw new ArgumentException("质量档位不受模型支持");
            body["quality"] = quality;
        }
        if (model.StartsWith("gpt-")) body["output_format"] = "png";
        return body;
    }

    private static (byte[] bytes, string mime, string extension) DecodeReference(string data)
    {
        Match match = Regex.Match(data ?? "", @"^data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$");
        if (!match.Success || data.Length > 28 * 1024 * 1024) throw new ArgumentException("参考图需为 PNG/JPEG/WebP，单图最多20MiB");
        byte[] bytes;
        try { bytes = Convert.FromBase64String(match.Groups[2].Value); }
        catch (FormatException) { throw new ArgumentException("参考图编码无效"); }
        if (bytes.Length > 20 * 1024 * 1024) throw new ArgumentException("参考图超过20MiB");
        try
        {
            var info = Image.Identify(bytes);
            if (info is null || (long)info.Width * info.Height > 32_000_000) throw new ArgumentException("参考图超过本应用32MP上限");
        }
        catch (ArgumentException) { throw; }
        catch { throw new ArgumentException("参考图不是可读取的图片"); }
        string mime = match.Groups[1].Value;
        return (bytes, mime, mime == "image/jpeg" ? "jpg" : mime[6..]);
    }

    private static async Task<JObject> Call(HttpRequestMessage request, string key, CancellationToken cancellation = default)
    {
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        using var response = await Client.SendAsync(request, cancellation);
        if (!response.IsSuccessStatusCode) throw new ProviderError((int)response.StatusCode);
        string text = await response.Content.ReadAsStringAsync(cancellation);
        if (text.Length > 2_000_000) throw new InvalidDataException("Provider response too large");
        JObject obj = JObject.Parse(text);
        if (obj["error"] is not null || obj.Value<int?>("code") is int code && code != 200) throw new ProviderError(obj.Value<int?>("code") ?? 502);
        return obj;
    }
    private class ProviderError(int code) : Exception
    {
        public readonly int Code = code;
        public string SafeMessage => Code switch { 401 or 403 => "APIMart 密钥或模型权限无效", 402 => "APIMart 余额不足", 429 => "APIMart 请求频率受限", 400 => "APIMart 拒绝了请求参数", _ => "APIMart 服务错误（" + Code + "）" };
    }

    public static async Task<JObject> SubmitStudioCloudImage(Session session, JObject rawInput)
    {
        string user = session.User.UserID, id;
        JObject body;
        try { id = Id((string)rawInput["request_id"]); body = ValidateRequest(rawInput, Capabilities); }
        catch (Exception e) when (e is ArgumentException or FormatException) { return Error(e.Message); }
        string key = Key();
        if (key.Length == 0) return Error("请在项目 .env 中填写 APIMART_API_KEY", "cloud_not_configured");
        var gate = Lock(user, id);
        await gate.WaitAsync();
        try
        {
            string fingerprint = RequestFingerprint(rawInput);
            JObject record = Read(user, id);
            if (record is not null) return (string)record["fingerprint"] == fingerprint ? Public(record) : Error("同一request_id不能用于不同请求");
            record = new() { ["request_id"] = id, ["fingerprint"] = fingerprint, ["status"] = "uploading", ["model"] = body["model"], ["prompt"] = body["prompt"], ["operation"] = rawInput["operation"], ["parameters"] = body.DeepClone(), ["reference_count"] = (rawInput["reference_images"] as JArray)?.Count ?? 0, ["created_utc"] = DateTime.UtcNow.ToString("o"), ["images"] = new JArray() };
            Save(user, record);
            bool submitted = false;
            try
            {
                JArray urls = [];
                foreach (JToken image in rawInput["reference_images"] as JArray ?? [])
                {
                    var file = DecodeReference(image.Value<string>());
                    using var form = new MultipartFormDataContent();
                    var content = new ByteArrayContent(file.bytes);
                    content.Headers.ContentType = new MediaTypeHeaderValue(file.mime);
                    form.Add(content, "file", "reference." + file.extension);
                    using var upload = new HttpRequestMessage(HttpMethod.Post, "https://api.apimart.ai/v1/uploads/images") { Content = form };
                    JObject uploadResult = await Call(upload, key);
                    string url = (string)uploadResult["url"];
                    if (!Uri.TryCreate(url, UriKind.Absolute, out Uri uri) || uri.Scheme != "https") throw new InvalidDataException("Invalid upload response");
                    urls.Add(url);
                }
                if (urls.Count > 0) body["image_urls"] = urls;
                record["status"] = "submitting";
                Save(user, record);
                using var generation = new HttpRequestMessage(HttpMethod.Post, "https://api.apimart.ai/v1/images/generations") { Content = new StringContent(body.ToString(Formatting.None), Encoding.UTF8, "application/json") };
                submitted = true;
                JObject result = await Call(generation, key);
                string task = (string)result["data"]?[0]?["task_id"];
                if (string.IsNullOrWhiteSpace(task)) throw new InvalidDataException("Missing task_id");
                record["task_id"] = task;
                record["status"] = "submitted";
                record["submitted_utc"] = DateTime.UtcNow.ToString("o");
            }
            catch (ProviderError e)
            {
                record["status"] = submitted && e.Code >= 500 ? "outcome_unknown" : "failed";
                record["error"] = e.SafeMessage;
            }
            catch
            {
                record["status"] = submitted ? "outcome_unknown" : "failed";
                record["error"] = submitted ? "提交响应未确认，禁止自动重发；请核对APIMart任务记录" : "参考图上传失败，未提交生成任务";
            }
            Save(user, record);
            return Public(record);
        }
        finally { gate.Release(); }
    }

    /// <summary>Flatten the documented images[].url[] shape without fabricating results.</summary>
    public static JArray NormalizeImages(JObject data)
    {
        JArray images = [];
        foreach (JObject item in data["result"]?["images"] as JArray ?? [])
        {
            if (item["url"] is not JArray urls) throw new InvalidDataException("images[].url must be an array");
            foreach (JToken url in urls)
            {
                if (url.Type != JTokenType.String || !Uri.TryCreate((string)url, UriKind.Absolute, out Uri uri) || uri.Scheme != "https") throw new InvalidDataException("Invalid result URL");
                images.Add(new JObject { ["index"] = images.Count, ["url"] = (string)url, ["remote_url"] = (string)url, ["expires_at"] = item["expires_at"] });
            }
        }
        return images;
    }

    private static async Task CacheImages(string id, JArray images)
    {
        string folder = Path.Combine(Root, "server/SwarmUI/src/wwwroot/studio-results");
        Directory.CreateDirectory(folder);
        foreach (JObject item in images)
        {
            if (((string)item["url"])?.StartsWith("/studio-results/") == true && item["sha256"] is not null) continue;
            try
            {
                using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(60));
                Uri uri = new((string)item["remote_url"]);
                // getapib.org is the CDN returned by the authenticated APIMart
                // Nano/Flare smoke tasks on 2026-10-14.
                if (uri.Host != "upload.apimart.ai" && uri.Host != "cdn.apimart.ai" && uri.Host != "getapib.org") throw new InvalidDataException("Unverified result host");
                using var response = await Client.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
                response.EnsureSuccessStatusCode();
                if (response.Content.Headers.ContentLength > 64 * 1024 * 1024) throw new InvalidDataException("Result too large");
                await using var input = await response.Content.ReadAsStreamAsync(deadline.Token);
                using var buffer = new MemoryStream();
                byte[] chunk = new byte[65536];
                int size;
                while ((size = await input.ReadAsync(chunk, deadline.Token)) > 0)
                {
                    if (buffer.Length + size > 64 * 1024 * 1024) throw new InvalidDataException("Result too large");
                    buffer.Write(chunk, 0, size);
                }
                byte[] bytes = buffer.ToArray();
                var info = Image.Identify(bytes);
                if (info is null || (long)info.Width * info.Height > 32_000_000) throw new InvalidDataException("Invalid result image");
                var format = info.Metadata.DecodedImageFormat;
                string extension = format?.FileExtensions.FirstOrDefault() ?? throw new InvalidDataException("Unknown image format");
                if (extension is not ("png" or "jpg" or "jpeg" or "webp")) throw new InvalidDataException("Unsupported image format");
                string name = id + "-" + (int)item["index"] + "." + extension;
                await File.WriteAllBytesAsync(Path.Combine(folder, name + ".tmp"), bytes);
                File.Move(Path.Combine(folder, name + ".tmp"), Path.Combine(folder, name), true);
                item["url"] = "/studio-results/" + name;
                item["width"] = info.Width;
                item["height"] = info.Height;
                item["mime_type"] = format.DefaultMimeType;
                item["sha256"] = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
                item.Remove("download_error");
            }
            catch { item["download_error"] = "自动转存未完成；远程结果可能到期，请下载保存"; }
        }
    }

    private static void Delivery(JObject record)
    {
        JArray images = record["images"] as JArray ?? [];
        int delivered = images.OfType<JObject>().Count(i => ((string)i["url"])?.StartsWith("/studio-results/") == true && i["sha256"] is not null);
        record["delivered_images"] = delivered;
        record["delivery_status"] = delivered == images.Count && images.Count == record["parameters"].Value<int>("n") ? "complete" : delivered == 0 ? "cache_pending" : "partial";
    }

    public static async Task<JObject> GetStudioCloudTask(Session session, string request_id)
    {
        string id;
        try { id = Id(request_id); } catch (ArgumentException e) { return Error(e.Message); }
        string user = session.User.UserID;
        var gate = Lock(user, id);
        // An in-flight submit retains its lock; reads must remain responsive.
        if (!await gate.WaitAsync(0))
        {
            JObject active = Read(user, id);
            return active is null ? Error("请求仍在初始化") : Public(active);
        }
        try
        {
            JObject record = Read(user, id);
            if (record is null) return Error("未找到本用户的云任务");
            string status = (string)record["status"];
            if (status == "completed")
            {
                JArray completedImages = record["images"] as JArray ?? [];
                if (completedImages.OfType<JObject>().Any(i => i["download_error"] is not null))
                {
                    await CacheImages(id, completedImages);
                    Delivery(record);
                    Save(user, record);
                }
                return Public(record);
            }
            if (status is "uploading" or "submitting")
            {
                record["status"] = "outcome_unknown";
                record["error"] = "服务重启前任务未确认，禁止自动重发；请核对APIMart记录";
                Save(user, record);
            }
            if ((string)record["task_id"] is not string task || status is "completed" or "failed" or "cancelled") return Public(record);
            string key = Key();
            if (key.Length == 0) { record["poll_error"] = "APIMART_API_KEY 未配置，暂不能查询"; return Public(record); }
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, "https://api.apimart.ai/v1/tasks/" + Uri.EscapeDataString(task) + "?language=zh");
                JObject result = await Call(request, key);
                JObject data = result["data"] as JObject ?? throw new InvalidDataException("Missing task data");
                string providerStatus = (string)data["status"];
                if (providerStatus is not ("pending" or "processing" or "completed" or "failed" or "cancelled")) throw new InvalidDataException("Unknown task status");
                record.Remove("poll_error");
                record["provider_status"] = providerStatus;
                foreach (string field in new[] { "progress", "cost", "credits_cost", "actual_time", "usage" }) if (data[field] is not null) record[field] = data[field].DeepClone();
                if (providerStatus == "completed")
                {
                    JArray images = NormalizeImages(data);
                    if (images.Count == 0) throw new InvalidDataException("Completed without images");
                    await CacheImages(id, images);
                    record["images"] = images;
                    Delivery(record);
                    record["completed_utc"] = DateTime.UtcNow.ToString("o");
                    if (images.Count != record["parameters"].Value<int>("n")) record["result_warning"] = "返回图片数量与请求不同，按实际结果展示";
                }
                record["status"] = providerStatus;
                if (providerStatus == "failed") record["error"] = "APIMart 任务生成失败；详情请查看供应商任务记录";
            }
            catch (ProviderError e) { record["poll_error"] = e.SafeMessage; }
            catch { record["poll_error"] = "任务查询或结果回读未确认，可继续查询；不会重新提交"; }
            Save(user, record);
            return Public(record);
        }
        finally { gate.Release(); }
    }

    public static Task<JObject> ListStudioCloudTasks(Session session)
    {
        string folder = UserFolder(session.User.UserID);
        JArray tasks = [];
        if (Directory.Exists(folder))
        {
            foreach (string path in Directory.EnumerateFiles(folder, "*.json").OrderByDescending(File.GetLastWriteTimeUtc).Take(200))
            {
                try { tasks.Add(Public(JObject.Parse(File.ReadAllText(path)))); } catch { }
            }
        }
        return Task.FromResult(new JObject { ["tasks"] = tasks });
    }
}
