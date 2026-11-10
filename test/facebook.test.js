import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFacebookImageInfo,
  fetchFacebookImage,
  fetchFacebookPage,
  getFacebookInfo,
  isFacebookCdnImageUrl,
  parseFacebookPage,
  parseMetaTags,
} from "../server/services/facebook.js";

// ---------------------------------------------------------------------------
// Fixtures modelled on public Facebook Open Graph markup
// ---------------------------------------------------------------------------

const VIDEO_HTML = `<!doctype html>
<html>
<head>
  <meta property="og:type" content="video.other">
  <meta property="og:title" content="ESL One Grand Finals | Dota 2">
  <meta property="og:description" content="The grand finals &amp; more">
  <meta property="og:url" content="https://www.facebook.com/WatchESLOne/videos/359649331226507/">
  <meta property="og:site_name" content="Facebook">
  <meta property="og:image" content="https://scontent.xx.fbcdn.net/v/t15.5256-10/abc123_n.jpg?stp=dst-jpg_s720x720&amp;oe=VIDEOTHUMB">
  <meta property="og:video" content="https://www.facebook.com/video/embed?video_id=359649331226507">
  <meta property="article:published_time" content="2024-05-01T10:00:00+0000">
</head>
<body></body>
</html>`;

const IMAGE_HTML = `<!doctype html>
<html>
<head>
  <meta property="og:type" content="article">
  <meta property="og:title" content="Sunset at the pier | Jane Doe">
  <meta property="og:description" content="A calm evening by the water.">
  <meta property="og:url" content="https://www.facebook.com/photo/?fbid=987654321098765">
  <meta property="og:site_name" content="Facebook">
  <meta property="og:image" content="https://scontent.xx.fbcdn.net/v/t39.30808-6/111_n.jpg?stp=dst-jpg_s960x960&amp;oe=IMAGEONE">
  <meta property="og:image:width" content="960">
  <meta property="og:image:height" content="720">
  <meta property="article:published_time" content="2024-06-02T08:30:00+0000">
</head>
<body></body>
</html>`;

const GALLERY_HTML = `<!doctype html>
<html>
<head>
  <meta property="og:type" content="article">
  <meta property="og:title" content="Weekend trip | Jane Doe">
  <meta property="og:url" content="https://www.facebook.com/someuser/posts/111111111111111/">
  <meta property="og:image" content="https://scontent.xx.fbcdn.net/v/t39.30808-6/111_n.jpg?stp=dst-jpg_s960x960&amp;oe=IMAGEONE">
  <meta property="og:image" content="https://static.xx.fbcdn.net/rsrc.php/v3/y8/r/not-media.png">
  <script type="application/json">
    {
      "photo_images": [
        {"uri": "https://scontent.xx.fbcdn.net/v/t39.30808-6/111_n.jpg?stp=dst-jpg_s960x960&oe=IMAGEONE", "width": 960, "height": 720},
        {"uri": "https://scontent.xx.fbcdn.net/v/t39.30808-6/222_n.jpg?stp=dst-jpg_s1080x1080&oe=IMAGETWO", "width": 1080, "height": 1080},
        {"uri": "https://scontent.xx.fbcdn.net/v/t15.5256-10/thumb_n.jpg?stp=dst-jpg_s320x320", "width": 320, "height": 320}
      ]
    }
  </script>
</head>
<body></body>
</html>`;

const LOGIN_HTML = `<!doctype html>
<html><body>
  <form id="login_form" action="/login/device-based/">
    <input name="email">
  </form>
</body></html>`;

const IMAGE_URL = "https://scontent.xx.fbcdn.net/v/t39.30808-6/111_n.jpg?stp=dst-jpg_s960x960&oe=IMAGEONE";
const IMAGE_URL_TWO = "https://scontent.xx.fbcdn.net/v/t39.30808-6/222_n.jpg?stp=dst-jpg_s1080x1080&oe=IMAGETWO";

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function redirectResponse(location, status = 302) {
  return new Response("", {
    status,
    headers: { location },
  });
}

async function withMockFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

// ---------------------------------------------------------------------------
// Metadata parsing
// ---------------------------------------------------------------------------

test("parseMetaTags lower-cases keys, decodes entities and keeps repeated images", () => {
  const meta = parseMetaTags(`
    <meta content="A &amp; B" property="og:title">
    <meta name='description' content='Hello &quot;world&quot; &amp; friends'>
    <meta property="og:image" content="https://scontent.xx.fbcdn.net/v/t39.30808-6/one.jpg">
    <meta content='https://scontent.xx.fbcdn.net/v/t39.30808-6/two.jpg' property='og:image'>
    <meta itemprop="image" content="https://scontent.xx.fbcdn.net/v/t39.30808-6/three.jpg">
  `);

  assert.deepEqual(meta["og:title"], ["A & B"]);
  assert.deepEqual(meta.description, ['Hello "world" & friends']);
  assert.deepEqual(meta["og:image"], [
    "https://scontent.xx.fbcdn.net/v/t39.30808-6/one.jpg",
    "https://scontent.xx.fbcdn.net/v/t39.30808-6/two.jpg",
  ]);
  assert.deepEqual(meta.image, ["https://scontent.xx.fbcdn.net/v/t39.30808-6/three.jpg"]);
});

test("parseFacebookPage reads public video metadata and keeps the video thumbnail", () => {
  const page = parseFacebookPage(VIDEO_HTML, "https://www.facebook.com/WatchESLOne/videos/359649331226507/");

  assert.equal(page.isVideo, true);
  assert.equal(page.ogType, "video.other");
  assert.equal(page.title, "ESL One Grand Finals");
  assert.equal(page.channel, "Dota 2");
  assert.equal(page.description, "The grand finals & more");
  assert.equal(page.uploadDate, "2024-05-01");
  assert.equal(page.canonicalUrl, "https://www.facebook.com/WatchESLOne/videos/359649331226507/");
  assert.equal(page.isLoginPage, false);
  assert.equal(page.images.length, 1);
  assert.equal(page.images[0].width, 720);
  assert.equal(page.images[0].height, 720);
});

test("parseFacebookPage reads a single public photo post", () => {
  const page = parseFacebookPage(IMAGE_HTML, "https://www.facebook.com/photo/?fbid=987654321098765");

  assert.equal(page.isVideo, false);
  assert.equal(page.title, "Sunset at the pier");
  assert.equal(page.channel, "Jane Doe");
  assert.equal(page.description, "A calm evening by the water.");
  assert.equal(page.uploadDate, "2024-06-02");
  assert.equal(page.hasPhotoMetadata, true);
  assert.equal(page.images.length, 1);
  assert.equal(page.images[0].width, 960);
  assert.equal(page.images[0].height, 720);
});

test("parseFacebookPage dedupes gallery images and drops thumbnails/static assets", () => {
  const page = parseFacebookPage(GALLERY_HTML, "https://www.facebook.com/someuser/posts/111111111111111/");

  assert.deepEqual(
    page.images.map((image) => image.url),
    [IMAGE_URL, IMAGE_URL_TWO]
  );
  assert.deepEqual(
    page.images.map((image) => [image.width, image.height]),
    [
      [960, 720],
      [1080, 1080],
    ]
  );
  assert.equal(page.hasPhotoMetadata, true);
});

test("parseFacebookPage flags login-gated pages", () => {
  const page = parseFacebookPage(LOGIN_HTML, "https://www.facebook.com/someuser/posts/111111111111111/");
  assert.equal(page.isLoginPage, true);
});

// ---------------------------------------------------------------------------
// CDN image filtering
// ---------------------------------------------------------------------------

test("isFacebookCdnImageUrl accepts real media URLs on any fbcdn host", () => {
  assert.equal(
    isFacebookCdnImageUrl("https://scontent.xx.fbcdn.net/v/t39.30808-6/abc_n.jpg?stp=dst-jpg_s960x960"),
    true
  );
  assert.equal(
    isFacebookCdnImageUrl("https://scontent-lax3-1.xx.fbcdn.net/v/t39.30808-6/abc_n.jpg?stp=dst-jpg_s1080x1080"),
    true
  );
  assert.equal(
    isFacebookCdnImageUrl("https:\\/\\/scontent.xx.fbcdn.net\\/v\\/t39.30808-6\\/abc_n.jpg?stp=dst-jpg_s960x960"),
    true
  );
});

test("isFacebookCdnImageUrl rejects static assets, tiny images and non-CDN hosts", () => {
  assert.equal(isFacebookCdnImageUrl("https://static.xx.fbcdn.net/rsrc.php/v3/y8/r/abc.png"), false);
  assert.equal(isFacebookCdnImageUrl("https://scontent.xx.fbcdn.net/v/t1.30497-1/abc_n.jpg?stp=dst-jpg_s64x64"), false);
  assert.equal(isFacebookCdnImageUrl("https://scontent.xx.fbcdn.net/v/t39.30808-6/abc_n.jpg/safe_image.php?url=x"), false);
  assert.equal(isFacebookCdnImageUrl("https://example.com/v/t39.30808-6/abc_n.jpg"), false);
  assert.equal(isFacebookCdnImageUrl("https://scontent.xx.fbcdn.net/images/profilepic/abc.jpg"), false);
  assert.equal(isFacebookCdnImageUrl("javascript:alert(1)"), false);
  assert.equal(isFacebookCdnImageUrl(""), false);
  assert.equal(isFacebookCdnImageUrl(null), false);
});

// ---------------------------------------------------------------------------
// Image info shape
// ---------------------------------------------------------------------------

test("buildFacebookImageInfo shapes a single image post", () => {
  const page = parseFacebookPage(IMAGE_HTML, "https://www.facebook.com/photo/?fbid=987654321098765");
  const info = buildFacebookImageInfo(page, {
    requestedUrl: "https://www.facebook.com/photo.php?fbid=987654321098765",
    resolvedUrl: "https://www.facebook.com/photo/?fbid=987654321098765",
  });

  assert.equal(info.platform, "facebook");
  assert.equal(info.mediaType, "image");
  assert.equal(info.videoId, "987654321098765");
  assert.equal(info.title, "Sunset at the pier");
  assert.equal(info.channel, "Jane Doe");
  assert.equal(info.imageCount, 1);
  assert.deepEqual(info.images, [{ index: 0, width: 960, height: 720 }]);
  assert.equal(info._images.length, 1);
  assert.equal(info._images[0].url, IMAGE_URL);
  assert.equal(info._downloadUrl, "https://www.facebook.com/photo/?fbid=987654321098765");
  assert.deepEqual(info.formats, []);
  assert.deepEqual(info.audioFormats, []);
});

test("buildFacebookImageInfo shapes a gallery and caps it at 20 images", () => {
  const two = buildFacebookImageInfo(
    {
      title: "Weekend trip | Jane Doe",
      channel: null,
      images: [
        { url: IMAGE_URL, width: 960, height: 720 },
        { url: IMAGE_URL_TWO, width: 1080, height: 1080 },
      ],
    },
    { requestedUrl: "https://www.facebook.com/someuser/posts/111111111111111/" }
  );

  assert.equal(two.mediaType, "gallery");
  assert.equal(two.imageCount, 2);
  assert.deepEqual(
    two.images.map((image) => image.index),
    [0, 1]
  );
  assert.equal(two.title, "Weekend trip");
  assert.equal(two.channel, "Jane Doe");
  assert.equal(two._downloadUrl, "https://www.facebook.com/someuser/posts/111111111111111/");

  const many = Array.from({ length: 25 }, (_, index) => ({
    url: `https://scontent.xx.fbcdn.net/v/t39.30808-6/${index}.jpg`,
    width: 1000,
    height: 1000,
  }));
  const capped = buildFacebookImageInfo(
    { title: "Many photos", images: many },
    { requestedUrl: "https://www.facebook.com/someuser/posts/222222222222222/" }
  );
  assert.equal(capped.imageCount, 20);
  assert.equal(capped.mediaType, "gallery");
});

test("buildFacebookImageInfo uses fallbacks and rejects empty pages", () => {
  const info = buildFacebookImageInfo(
    {
      title: null,
      channel: null,
      images: [{ url: IMAGE_URL, width: null, height: null }],
    },
    { requestedUrl: "https://www.facebook.com/photo.php?fbid=987654321098765" }
  );

  assert.equal(info.title, "Facebook photo");
  assert.equal(info.channel, "Facebook");
  assert.equal(info.videoId, "987654321098765");
  assert.deepEqual(info.images, [{ index: 0, width: null, height: null }]);

  assert.throws(
    () => buildFacebookImageInfo({ title: "Empty", images: [] }, { requestedUrl: "https://www.facebook.com/photo.php?fbid=987654321098765" }),
    (error) => {
      assert.equal(error.status, 404);
      assert.equal(error.code, "POST_UNAVAILABLE");
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Page fetching (mocked network)
// ---------------------------------------------------------------------------

test("fetchFacebookPage resolves a share redirect and returns the final URL", async () => {
  const requested = [];
  await withMockFetch(
    async (url) => {
      requested.push(String(url));
      if (requested.length === 1) {
        return redirectResponse("https://www.facebook.com/photo/?fbid=987654321098765");
      }
      return htmlResponse(IMAGE_HTML);
    },
    async () => {
      const page = await fetchFacebookPage("https://www.facebook.com/share/p/AbCdEf123/");
      assert.equal(page.resolvedUrl, "https://www.facebook.com/photo/?fbid=987654321098765");
      assert.equal(page.images.length, 1);
      assert.equal(requested.length, 2);
    }
  );
});

test("fetchFacebookPage maps login, missing-post, rate-limit and redirect failures", async () => {
  await withMockFetch(
    async () => htmlResponse(LOGIN_HTML),
    async () => {
      await assert.rejects(fetchFacebookPage("https://www.facebook.com/photo/?fbid=987654321098765"), (error) => {
        assert.equal(error.status, 403);
        assert.equal(error.code, "LOGIN_REQUIRED");
        return true;
      });
    }
  );

  await withMockFetch(
    async () => htmlResponse("not found", 404),
    async () => {
      await assert.rejects(fetchFacebookPage("https://www.facebook.com/photo/?fbid=987654321098765"), (error) => {
        assert.equal(error.status, 404);
        assert.equal(error.code, "POST_UNAVAILABLE");
        return true;
      });
    }
  );

  await withMockFetch(
    async () => htmlResponse("slow down", 429),
    async () => {
      await assert.rejects(fetchFacebookPage("https://www.facebook.com/photo/?fbid=987654321098765"), (error) => {
        assert.equal(error.status, 429);
        assert.equal(error.code, "RATE_LIMITED");
        return true;
      });
    }
  );

  await withMockFetch(
    async () => htmlResponse("boom", 500),
    async () => {
      await assert.rejects(fetchFacebookPage("https://www.facebook.com/photo/?fbid=987654321098765"), (error) => {
        assert.equal(error.status, 502);
        assert.equal(error.code, "UPSTREAM_FAILURE");
        return true;
      });
    }
  );

  await withMockFetch(
    async () => redirectResponse("https://example.com/not-facebook"),
    async () => {
      await assert.rejects(fetchFacebookPage("https://fb.watch/abcDE12345/"), (error) => {
        assert.equal(error.status, 502);
        assert.equal(error.code, "UPSTREAM_FAILURE");
        return true;
      });
    }
  );

  await assert.rejects(fetchFacebookPage("https://example.com/photo"), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, "UNSUPPORTED_URL");
    return true;
  });
});

// ---------------------------------------------------------------------------
// Image fetching (mocked network)
// ---------------------------------------------------------------------------

test("fetchFacebookImage returns the bytes and content type", async () => {
  const payload = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]);
  await withMockFetch(
    async () =>
      new Response(payload, {
        status: 200,
        headers: { "content-type": "image/jpeg", "content-length": String(payload.length) },
      }),
    async () => {
      const result = await fetchFacebookImage(IMAGE_URL);
      assert.equal(result.contentType, "image/jpeg");
      assert.deepEqual(result.buffer, payload);
      assert.equal(result.finalUrl, IMAGE_URL);
    }
  );
});

test("fetchFacebookImage rejects unsupported URLs before any network call", async () => {
  let called = false;
  await withMockFetch(
    async () => {
      called = true;
      return htmlResponse("nope");
    },
    async () => {
      await assert.rejects(fetchFacebookImage("https://example.com/photo.jpg"), (error) => {
        assert.equal(error.status, 400);
        assert.equal(error.code, "UNSUPPORTED_URL");
        return true;
      });
    }
  );
  assert.equal(called, false);
});

test("fetchFacebookImage maps missing images and non-image responses", async () => {
  await withMockFetch(
    async () => htmlResponse("gone", 404),
    async () => {
      await assert.rejects(fetchFacebookImage(IMAGE_URL), (error) => {
        assert.equal(error.status, 404);
        assert.equal(error.code, "IMAGE_UNAVAILABLE");
        return true;
      });
    }
  );

  await withMockFetch(
    async () => htmlResponse("<html>not an image</html>"),
    async () => {
      await assert.rejects(fetchFacebookImage(IMAGE_URL), (error) => {
        assert.equal(error.status, 502);
        assert.equal(error.code, "UPSTREAM_FAILURE");
        return true;
      });
    }
  );
});

// ---------------------------------------------------------------------------
// Video/image dispatch
// ---------------------------------------------------------------------------

test("getFacebookInfo uses yt-dlp for a direct video link and keeps the canonical URL", async () => {
  const calls = [];
  const info = await getFacebookInfo("https://m.facebook.com/watch?v=123456789012345&ref=x", {
    getVideoInfo: async (url) => {
      calls.push(url);
      return { platform: "facebook", mediaType: "video", title: "Video", _downloadUrl: url };
    },
  });

  assert.deepEqual(calls, ["https://www.facebook.com/watch/?v=123456789012345"]);
  assert.equal(info.mediaType, "video");
  assert.equal(info._downloadUrl, "https://www.facebook.com/watch/?v=123456789012345");
});

test("getFacebookInfo does not spend a page fetch on fatal yt-dlp video errors", async () => {
  let fetched = false;
  await withMockFetch(
    async () => {
      fetched = true;
      return htmlResponse(IMAGE_HTML);
    },
    async () => {
      await assert.rejects(
        getFacebookInfo("https://www.facebook.com/reel/1195289147628387/", {
          getVideoInfo: async () => {
            const error = new Error("This video is private.");
            error.status = 403;
            error.code = "PRIVATE_VIDEO";
            throw error;
          },
        }),
        (error) => {
          assert.equal(error.status, 403);
          assert.equal(error.code, "PRIVATE_VIDEO");
          return true;
        }
      );
    }
  );
  assert.equal(fetched, false);
});

test("getFacebookInfo falls back to public image metadata when a video extraction fails", async () => {
  await withMockFetch(
    async () => htmlResponse(IMAGE_HTML),
    async () => {
      const info = await getFacebookInfo("https://www.facebook.com/watch/?v=123456789012345", {
        getVideoInfo: async () => {
          throw new Error("Not a video after all");
        },
      });

      assert.equal(info.mediaType, "image");
      assert.equal(info.imageCount, 1);
      assert.equal(
        info._downloadUrl,
        "https://www.facebook.com/watch/?v=123456789012345"
      );
    }
  );
});

test("getFacebookInfo reads photo posts without calling yt-dlp", async () => {
  let called = false;
  await withMockFetch(
    async () => htmlResponse(IMAGE_HTML),
    async () => {
      const info = await getFacebookInfo("https://www.facebook.com/photo.php?fbid=987654321098765", {
        getVideoInfo: async () => {
          called = true;
          throw new Error("should not run");
        },
      });

      assert.equal(called, false);
      assert.equal(info.mediaType, "image");
      assert.equal(info.videoId, "987654321098765");
      assert.equal(info._downloadUrl, "https://www.facebook.com/photo/?fbid=987654321098765");
    }
  );
});

test("getFacebookInfo sends a video-shaped photo link through yt-dlp", async () => {
  const calls = [];
  await withMockFetch(
    async () => htmlResponse(VIDEO_HTML),
    async () => {
      const info = await getFacebookInfo("https://www.facebook.com/photo.php?fbid=987654321098765", {
        getVideoInfo: async (url) => {
          calls.push(url);
          return { platform: "facebook", mediaType: "video", title: "Video", _downloadUrl: url };
        },
      });

      assert.deepEqual(calls, ["https://www.facebook.com/photo/?fbid=987654321098765"]);
      assert.equal(info.mediaType, "video");
    }
  );
});

test("getFacebookInfo resolves generic post links to the public media type", async () => {
  await withMockFetch(
    async () => htmlResponse(GALLERY_HTML),
    async () => {
      const info = await getFacebookInfo("https://www.facebook.com/someuser/posts/111111111111111/", {
        getVideoInfo: async () => {
          throw new Error("no video");
        },
      });
      assert.equal(info.mediaType, "gallery");
      assert.equal(info.imageCount, 2);
    }
  );

  await withMockFetch(
    async () => htmlResponse(VIDEO_HTML),
    async () => {
      const calls = [];
      const info = await getFacebookInfo("https://www.facebook.com/someuser/posts/111111111111111/", {
        getVideoInfo: async (url) => {
          calls.push(url);
          return { platform: "facebook", mediaType: "video", title: "Video", _downloadUrl: url };
        },
      });
      assert.deepEqual(calls, ["https://www.facebook.com/someuser/posts/111111111111111/"]);
      assert.equal(info.mediaType, "video");
    }
  );
});

test("getFacebookInfo reports private posts and unsupported pages clearly", async () => {
  await withMockFetch(
    async () => htmlResponse(LOGIN_HTML),
    async () => {
      await assert.rejects(
        getFacebookInfo("https://www.facebook.com/someuser/posts/111111111111111/", {
          getVideoInfo: async () => {
            throw new Error("no video");
          },
        }),
        (error) => {
          assert.equal(error.status, 403);
          assert.equal(error.code, "LOGIN_REQUIRED");
          return true;
        }
      );
    }
  );

  await withMockFetch(
    async () => htmlResponse("<html><head><title>Facebook</title></head><body></body></html>"),
    async () => {
      await assert.rejects(
        getFacebookInfo("https://www.facebook.com/someuser/posts/111111111111111/", {
          getVideoInfo: async () => {
            throw new Error("no video");
          },
        }),
        (error) => {
          assert.equal(error.status, 404);
          assert.equal(error.code, "POST_UNAVAILABLE");
          return true;
        }
      );
    }
  );

  await assert.rejects(
    getFacebookInfo("https://www.facebook.com/photo.php?fbid=987654321098765"),
    (error) => {
      assert.equal(error.status, 500);
      assert.equal(error.code, "UNKNOWN");
      return true;
    }
  );
});
