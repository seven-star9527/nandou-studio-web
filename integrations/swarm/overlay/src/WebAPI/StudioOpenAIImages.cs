using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SwarmUI.Accounts;

namespace SwarmUI.WebAPI;

public static partial class StudioCloudAPI
{
    private static readonly HttpClient OfficialClient = new(new HttpClientHandler { AllowAutoRedirect = false })
    {
        Timeout = TimeSpan.FromMinutes(12),
        MaxResponseContentBufferSize = 384L * 1024 * 1024
    };
    private static readonly ConcurrentDictionary<string, DateTime> ExhaustedUntil = new();
    private static long officialSequence = -1;

    private static string[] OfficialKeys() => Key("OPENAI_API_KEYS").Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
        .Append(Key("OPENAI_API_KEY")).Where(key => key.Length > 0).Distinct(StringComparer.Ordinal).ToArray();

    private static bool CanUseOfficial(JObject body, JObject input) =>
        (string)body["model"] is "gpt-image-2.6-flare" or "gpt-image-2.6-sunburst"
        && !((string)body["output_format"] == "svg" && (input["reference_images"] as JArray)?.Count > 0);

    private static HttpRequestMessage OfficialRequest(JObject body, JArray references)
    {
        JObject fields = (JObject)body.DeepClone();
        string size = (string)fields["size"];
        if (size.Contains(':'))
        {
            string resolution = ((string)fields["resolution"]).ToUpperInvariant();
            JObject model = Capabilities["models"].OfType<JObject>().Single(m => (string)m["id"] == (string)body["model"]);
            JArray pixels = model["sizeMap"]?[resolution]?[size] as JArray ?? throw new ArgumentException("画幅没有对应的像素尺寸");
            fields["size"] = $"{pixels[0]}x{pixels[1]}";
        }
        fields.Remove("resolution");
        fields.Remove("svg"); // The official endpoint uses its default SVG author.
        if (references.Count == 0)
            return new(HttpMethod.Post, "https://api.openai.com/v1/images/generations")
            {
                Content = new StringContent(fields.ToString(Formatting.None), Encoding.UTF8, "application/json")
            };
        var form = new MultipartFormDataContent();
        foreach (var field in fields.Properties()) form.Add(new StringContent((string)field.Value), field.Name);
        int index = 0;
        foreach (var reference in references)
        {
            var file = DecodeReference((string)reference);
            var content = new ByteArrayContent(file.bytes);
            content.Headers.ContentType = new MediaTypeHeaderValue(file.mime);
            form.Add(content, "image[]", $"reference-{++index}.{file.extension}");
        }
        return new(HttpMethod.Post, "https://api.openai.com/v1/images/edits") { Content = form };
    }

    private static bool Exhausted(int status, string code) =>
        status is 402 or 429 or 400 && code is "credit_balance_exhausted" or "organization_spend_limit_exceeded"
            or "project_spend_limit_exceeded" or "insufficient_quota" or "billing_hard_limit_reached";

    private static async Task RunOfficialPool(Session session, string user, JObject input, JObject body, JObject record, string[] keys, string fallbackKey)
    {
        string id = (string)record["request_id"];
        JArray refs = input["reference_images"] as JArray ?? [];
        int start = (int)((ulong)Interlocked.Increment(ref officialSequence) % (uint)keys.Length);
        record["status"] = "submitting";
        record["submitted_utc"] = DateTime.UtcNow.ToString("o");
        Save(user, record);
        for (int offset = 0; offset < keys.Length; offset++)
        {
            string key = keys[(start + offset) % keys.Length];
            string keyId = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(key)));
            if (ExhaustedUntil.TryGetValue(keyId, out var until) && until > DateTime.UtcNow) continue;
            using var request = OfficialRequest(body, refs);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
            using var response = await OfficialClient.SendAsync(request);
            if (!response.IsSuccessStatusCode)
            {
                int status = (int)response.StatusCode;
                string code = null;
                try { code = (string)JObject.Parse(await response.Content.ReadAsStringAsync())["error"]?["code"]; }
                catch (JsonException) { }
                if (Exhausted(status, code))
                {
                    ExhaustedUntil[keyId] = DateTime.UtcNow.AddMinutes(5);
                    continue;
                }
                record["status"] = status >= 500 || status == 408 ? "outcome_unknown" : "failed";
                record["error"] = status switch
                {
                    401 or 403 => "模型访问被拒绝，请管理员检查密钥和模型权限。",
                    429 => "模型请求受到限流，请稍后再试。",
                    400 => "模型拒绝了本次输入或参数。",
                    _ => $"模型服务返回 HTTP {status}，请核对任务记录。"
                };
                Save(user, record);
                return;
            }

            var payload = JObject.Parse(await response.Content.ReadAsStringAsync());
            SaveOfficialUsage(id, keyId, body, payload, response);
            record["credits_cost"] = 0;
            var quote = await GetStudioCloudQuote(session, body);
            record["estimated_credits"] = quote["credits_total_reference"]?.DeepClone();
            record["reference_billing"] = true;
            var results = payload["data"] as JArray;
            if (results == null || results.Count == 0 || results.Count > body.Value<int>("n"))
                throw new InvalidDataException("Unexpected number of images");
            string folder = Path.Combine(Root, "server/SwarmUI/src/wwwroot/studio-results");
            Directory.CreateDirectory(folder);
            var images = (JArray)record["images"];
            foreach (var result in results)
            {
                byte[] bytes = Convert.FromBase64String((string)result["b64_json"] ?? "");
                if (bytes.Length is 0 or > 67108864) throw new InvalidDataException("Invalid image size");
                var item = new JObject { ["index"] = images.Count };
                await SaveImage(folder, id, item, bytes, (string)body["output_format"]);
                images.Add(item);
                Save(user, record);
            }
            Delivery(record);
            record["status"] = "completed";
            record["completed_utc"] = DateTime.UtcNow.ToString("o");
            if (images.Count < body.Value<int>("n")) record["result_warning"] = "返回图片数量少于请求，已保存收到的结果。";
            Save(user, record);
            return;
        }

        if (fallbackKey.Length > 0)
        {
            await SubmitMart(user, input, body, record, fallbackKey);
            return;
        }
        record["status"] = "failed";
        record["error"] = "所有生图密钥额度已耗尽，备用密钥尚未配置。";
        record["credits_cost"] = 0;
        Save(user, record);
    }

    // Private accounting receipts are independent of both public history and image delivery.
    private static void SaveOfficialUsage(string id, string keyId, JObject body, JObject payload, HttpResponseMessage response)
    {
        var usage = payload["usage"] as JObject;
        long? Tokens(JToken value) => value?.Type == JTokenType.Integer && (long)value >= 0 ? (long)value : null;
        var text = Tokens(usage?["input_tokens_details"]?["text_tokens"]);
        var image = Tokens(usage?["input_tokens_details"]?["image_tokens"]);
        var output = Tokens(usage?["output_tokens"]);
        // Standard Images API list prices, USD per million tokens. SVG authoring is separately billed.
        decimal? usd = null;
        if ((string)body["output_format"] != "svg" && payload["svg_usage"] == null
            && text.HasValue && image.HasValue && output.HasValue
            && text + image == Tokens(usage?["input_tokens"]))
            usd = (text * 5m + image * 8m + output * 30m) / 1_000_000m;
        var receipt = new JObject
        {
            ["id"] = id, ["key_id"] = keyId[..12], ["model"] = (string)body["model"],
            ["at"] = DateTime.UtcNow.ToString("o"), ["estimated_usd"] = usd,
            ["usage"] = usage?.DeepClone(), ["svg_usage"] = payload["svg_usage"]?.DeepClone(),
            ["upstream_request"] = response.Headers.TryGetValues("x-request-id", out var ids) ? ids.FirstOrDefault() : null
        };
        string dir = Path.Combine(Root, "server/SwarmUI/Data/StudioOfficialUsage");
        Directory.CreateDirectory(dir);
        string path = Path.Combine(dir, id + ".json");
        File.WriteAllText(path + ".tmp", receipt.ToString(Formatting.None));
        File.Move(path + ".tmp", path, true);
    }
}
