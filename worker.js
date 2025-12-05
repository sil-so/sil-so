export default {
  async scheduled(controller, env, ctx) {
    const RESET_CRON = "0 0 * * 1";
    try {
      const response = await fetch(
        `https://whatpulse.org/api/v1/users/${env.WHATPULSE_USER_ID}`,
        {
          headers: {
            Authorization: `Bearer ${env.WHATPULSE_API_TOKEN}`,
            Accept: "application/json",
          },
        },
      );

      if (!response.ok)
        throw new Error(`WhatPulse API Error: ${response.status}`);

      const json = await response.json();
      if (!json.user?.totals) throw new Error("Structure mismatch");

      const currentMiles = parseFloat(json.user.totals.distance_miles || 0);
      const currentClicks = parseInt(json.user.totals.clicks || 0);

      let baselineMiles = parseFloat(
        await env.WHATPULSE_DATA.get("baseline_miles"),
      );
      let baselineClicks = parseInt(
        await env.WHATPULSE_DATA.get("baseline_clicks"),
      );

      const isResetTime = controller.cron === RESET_CRON;
      const isFirstRun = isNaN(baselineMiles) || isNaN(baselineClicks);

      if (isResetTime || isFirstRun) {
        await env.WHATPULSE_DATA.put("baseline_miles", currentMiles.toString());
        await env.WHATPULSE_DATA.put(
          "baseline_clicks",
          currentClicks.toString(),
        );
        baselineMiles = currentMiles;
        baselineClicks = currentClicks;
      }

      const weeklyKm = ((currentMiles - baselineMiles) * 1.60934).toFixed(2);
      const weeklyClicks = currentClicks - baselineClicks;

      const stats = {
        distance: new Intl.NumberFormat("en-US").format(weeklyKm),
        clicks: new Intl.NumberFormat("en-US", {
          notation: "compact",
          maximumFractionDigits: 1,
        }).format(weeklyClicks),
        updatedAt: new Date().toISOString(),
      };

      await env.WHATPULSE_DATA.put("stats", JSON.stringify(stats));
    } catch (error) {
      console.error(error.message);
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/blog" || url.pathname === "/blog/") {
      return handleBlogList(request, env);
    }

    if (
      url.pathname.startsWith("/blog/") &&
      url.pathname.split("/").length > 2
    ) {
      const slug = url.pathname.split("/")[2];
      if (slug) return handleBlogPost(slug, request, env);
    }

    const response = await env.ASSETS.fetch(request);

    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("text/html")) {
      const statsData = await env.WHATPULSE_DATA.get("stats", { type: "json" });
      const data = statsData || {
        distance: "--",
        clicks: "--",
        updatedAt: null,
      };

      return new HTMLRewriter()
        .on("a[href]", new CleanHtmlExtensionHandler())
        .on("#activity-mouse-travel", new TextHandler(data.distance))
        .on("#activity-mouse-clicks", new TextHandler(data.clicks))
        .on(
          "#activity-last-update",
          new TextHandler(formatUpdateTime(data.updatedAt)),
        )
        .transform(response);
    }

    return response;
  },
};

async function handleBlogList(request, env) {
  const url = new URL(request.url);
  const templateReq = new Request(`${url.origin}/blog.html`, {
    headers: request.headers,
  });
  const templateRes = await env.ASSETS.fetch(templateReq);

  if (!templateRes.ok) return new Response("Not Found", { status: 404 });

  const cloneRes = templateRes.clone();
  const templateHtml = await extractTemplateRobust(cloneRes);

  if (!templateHtml)
    return new Response("Error: data-template='item' not found", {
      status: 500,
    });

  try {
    const posts = await getNotionPosts(env);
    let generatedListHtml = "";

    for (const post of posts) {
      const populatedItem = await populateTemplate(templateHtml, post);
      generatedListHtml += populatedItem;
    }

    const fullHtml = await templateRes.text();
    const response = new Response(fullHtml, {
      headers: { "Content-Type": "text/html" },
    });

    return new HTMLRewriter()
      .on("a[href]", new CleanHtmlExtensionHandler())
      .on("#blog-list", {
        element(el) {
          el.setInnerContent(generatedListHtml, { html: true });
        },
      })
      .on(
        'script[type="application/ld+json"]',
        new BlogListSchemaHandler(posts, `${url.origin}/blog`),
      )
      .transform(response);
  } catch (error) {
    return new Response(error.message, { status: 500 });
  }
}

async function handleBlogPost(slug, request, env) {
  const url = new URL(request.url);
  const templateReq = new Request(`${url.origin}/blog-post.html`, {
    headers: request.headers,
  });
  const templateRes = await env.ASSETS.fetch(templateReq);

  if (!templateRes.ok)
    return new Response("Template Not Found", { status: 404 });

  try {
    const post = await getNotionPostBySlug(slug, env);
    if (!post) return new Response("Post Not Found", { status: 404 });

    const datePublished = new Date(post.date);
    const dateUpdated = post.updated ? new Date(post.updated) : datePublished;
    const isoPublished = datePublished.toISOString();
    const isoUpdated = dateUpdated.toISOString();

    const readablePublished = datePublished.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    const readableUpdated = dateUpdated.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    const metaDesc = post.description || `Read more about ${post.title}.`;
    const metaTitle = `${post.title} | Silvan Soeters`;

    return new HTMLRewriter()
      .on("head", new BaseTagHandler())
      .on("a[href]", new CleanHtmlExtensionHandler())
      .on("title", new TextHandler(metaTitle))
      .on('meta[name="description"]', new AttributeHandler("content", metaDesc))
      .on(
        'meta[property="og:title"]',
        new AttributeHandler("content", metaTitle),
      )
      .on(
        'meta[property="og:description"]',
        new AttributeHandler("content", metaDesc),
      )
      .on(
        'meta[property="og:image"]',
        new AttributeHandler("content", post.cover),
      )
      .on(
        'meta[name="twitter:title"]',
        new AttributeHandler("content", metaTitle),
      )
      .on(
        'meta[name="twitter:description"]',
        new AttributeHandler("content", metaDesc),
      )
      .on(
        'meta[name="twitter:image"]',
        new AttributeHandler("content", post.cover),
      )
      .on('link[rel="canonical"]', new AttributeHandler("href", url.href))
      .on(
        'script[type="application/ld+json"]',
        new SchemaHandler(post, isoPublished, isoUpdated, url.href, metaDesc),
      )
      .on("#post-title", new TextHandler(post.title))
      .on(
        "#post-published",
        new DateAttributeHandler(readablePublished, isoPublished),
      )
      .on(
        "#post-updated",
        new DateAttributeHandler(readableUpdated, isoUpdated),
      )
      .on("#post-banner img", new ImageHandler(post.cover, post.title))
      .on("#post-content", new TextHandler(post.contentHtml, true))
      .transform(templateRes);
  } catch (error) {
    return new Response(error.message, { status: 500 });
  }
}

async function extractTemplateRobust(resClone) {
  let found = false;
  const rewriter = new HTMLRewriter().on('[data-template="item"]', {
    element(el) {
      found = true;
      el.before("|||TEMPLATE_START|||");
      el.after("|||TEMPLATE_END|||");
    },
  });

  const transformed = rewriter.transform(resClone);
  const text = await transformed.text();

  if (!found) return null;

  const parts = text.split("|||TEMPLATE_START|||");
  if (parts.length < 2) return null;

  const endParts = parts[1].split("|||TEMPLATE_END|||");
  return endParts[0];
}

async function populateTemplate(templateHtml, post) {
  const res = new Response(templateHtml);

  const transformed = new HTMLRewriter()
    .on('[data-bind="title"]', new TextHandler(post.title))
    .on(
      '[data-bind="date"]',
      new TextHandler(new Date(post.date).toLocaleDateString("nl-NL")),
    )
    .on('[data-bind="description"]', new TextHandler(post.description))
    .on(
      '[data-bind="link"]',
      new LinkAttributeHandler(`/blog/${post.slug}`, post.title),
    )
    .on('[data-bind="image"]', new ImageHandler(post.cover, post.title))
    .on('[data-template="item"]', {
      element(el) {
        el.removeAttribute("data-template");
      },
    })
    .transform(res);

  return await transformed.text();
}

async function collectPaginatedAPI(url, options, bodyBase = null) {
  let results = [];
  let hasMore = true;
  let cursor = undefined;

  while (hasMore) {
    const finalBody = bodyBase ? { ...bodyBase } : {};
    if (cursor) finalBody.start_cursor = cursor;

    const fetchOptions = { ...options };
    if (bodyBase || cursor) {
      fetchOptions.body = JSON.stringify(finalBody);
    }

    const response = await fetch(url, fetchOptions);
    if (!response.ok) return results;

    const data = await response.json();
    results = results.concat(data.results);
    hasMore = data.has_more;
    cursor = data.next_cursor;
  }
  return results;
}

async function getNotionPosts(env) {
  const cacheKey = "notion_posts_list";
  const cached = await env.BLOG_CACHE.get(cacheKey, { type: "json" });
  if (cached) return cached;

  const results = await collectPaginatedAPI(
    `https://api.notion.com/v1/databases/${env.NOTION_DB_ID}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
    },
    {
      filter: { property: "Status", select: { equals: "Published" } },
      sorts: [{ property: "PublishedDate", direction: "descending" }],
      page_size: 100,
    },
  );

  const posts = results.map((page) => ({
    id: page.id,
    title: page.properties.Name?.title[0]?.plain_text || "Untitled",
    slug: page.properties.Slug?.rich_text[0]?.plain_text || page.id,
    date: page.properties.PublishedDate?.date?.start || "",
    updated: page.properties.UpdatedDate?.date?.start || null,
    description: page.properties.Description?.rich_text[0]?.plain_text || "",
    cover: page.cover?.external?.url || page.cover?.file?.url || null,
  }));

  await env.BLOG_CACHE.put(cacheKey, JSON.stringify(posts), {
    expirationTtl: 1800,
  });
  return posts;
}

async function getNotionPostBySlug(slug, env) {
  const allPosts = await getNotionPosts(env);
  const postInfo = allPosts.find((p) => p.slug === slug);
  if (!postInfo) return null;

  const cacheKey = `notion_post_${postInfo.id}`;
  const cached = await env.BLOG_CACHE.get(cacheKey, { type: "json" });
  if (cached) return cached;

  const results = await collectPaginatedAPI(
    `https://api.notion.com/v1/blocks/${postInfo.id}/children?page_size=100`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${env.NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
      },
    },
  );

  const htmlContent = convertBlocksToHtml(results);
  const fullPost = { ...postInfo, contentHtml: htmlContent };

  await env.BLOG_CACHE.put(cacheKey, JSON.stringify(fullPost), {
    expirationTtl: 1800,
  });
  return fullPost;
}

function convertBlocksToHtml(blocks) {
  if (!blocks) return "";
  let html = "";
  let listTag = null;
  const closeList = () => {
    if (listTag) {
      html += `</${listTag}>`;
      listTag = null;
    }
  };
  blocks.forEach((block) => {
    if (block.type === "bulleted_list_item" && listTag !== "ul") {
      closeList();
      html += "<ul>";
      listTag = "ul";
    } else if (block.type === "numbered_list_item" && listTag !== "ol") {
      closeList();
      html += "<ol>";
      listTag = "ol";
    } else if (
      block.type !== "bulleted_list_item" &&
      block.type !== "numbered_list_item"
    ) {
      closeList();
    }

    switch (block.type) {
      case "paragraph":
        const p = parseRichText(block.paragraph.rich_text);
        html += p ? `<p>${p}</p>` : `<br>`;
        break;
      case "heading_1":
        html += `<h2>${parseRichText(block.heading_1.rich_text)}</h2>`;
        break;
      case "heading_2":
        html += `<h2>${parseRichText(block.heading_2.rich_text)}</h2>`;
        break;
      case "heading_3":
        html += `<h3>${parseRichText(block.heading_3.rich_text)}</h3>`;
        break;
      case "heading_4":
        html += `<h4>${parseRichText(block.heading_4.rich_text)}</h4>`;
        break;
      case "bulleted_list_item":
        html += `<li>${parseRichText(block.bulleted_list_item.rich_text)}</li>`;
        break;
      case "numbered_list_item":
        html += `<li>${parseRichText(block.numbered_list_item.rich_text)}</li>`;
        break;
      case "quote":
        html += `<blockquote>${parseRichText(block.quote.rich_text)}</blockquote>`;
        break;
      case "image":
        const src =
          block.image.type === "external"
            ? block.image.external.url
            : block.image.file.url;
        const cap = parseRichText(block.image.caption);
        html += `<figure class="w-richtext-align-fullwidth w-richtext-figure-type-image" style="max-width: 100%;"><div><img src="${src}" alt="${cap}" loading="lazy"></div>${cap ? `<figcaption>${cap}</figcaption>` : ""}</figure>`;
        break;
      case "video":
        const vSrc =
          block.video.type === "external"
            ? block.video.external.url
            : block.video.file.url;
        html += `<div class="w-embed w-script"><video controls playsinline style="width: 100%; height: auto; border-radius: 8px; display: block; max-width: 100%;"><source src="${vSrc}" type="video/mp4"></video></div>`;
        break;
      case "code":
        const lng = block.code.language || "javascript";
        html += `<pre class="w-code-block"><code class="language-${lng}">${parseRichText(block.code.rich_text)}</code></pre>`;
        break;
      case "divider":
        html += `<div class="w-rich-separator"></div>`;
        break;
    }
  });
  closeList();
  return html;
}

function parseRichText(richTextArray) {
  if (!richTextArray) return "";
  return richTextArray
    .map((chunk) => {
      let text = chunk.plain_text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      if (chunk.annotations.bold) text = `<strong>${text}</strong>`;
      if (chunk.annotations.italic) text = `<em>${text}</em>`;
      if (chunk.annotations.code) text = `<code>${text}</code>`;
      if (chunk.annotations.underline)
        text = `<span style="text-decoration: underline;">${text}</span>`;
      if (chunk.annotations.strikethrough)
        text = `<span style="text-decoration: line-through;">${text}</span>`;
      if (chunk.href)
        text = `<a href="${chunk.href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
      return text;
    })
    .join("");
}

function formatUpdateTime(isoString) {
  if (!isoString) return "";
  const date = new Date(isoString);
  return date
    .toLocaleTimeString("en-US", {
      hour: "numeric",
      hour12: true,
      timeZone: "Europe/Amsterdam",
      timeZoneName: "shortOffset",
    })
    .replace("GMT", "UTC");
}

class BaseTagHandler {
  element(element) {
    element.prepend('<base href="/">', { html: true });
  }
}

class CleanHtmlExtensionHandler {
  element(element) {
    const href = element.getAttribute("href");
    if (href && href.endsWith(".html")) {
      element.setAttribute("href", href.replace(/\.html$/, ""));
    }
    if (href === "index.html") {
      element.setAttribute("href", "/");
    }
  }
}

class TextHandler {
  constructor(content, isHtml = false) {
    this.content = content;
    this.isHtml = isHtml;
  }
  element(element) {
    if (this.content !== undefined && this.content !== null)
      this.isHtml
        ? element.setInnerContent(this.content, { html: true })
        : element.setInnerContent(this.content);
  }
}

class AttributeHandler {
  constructor(attribute, value) {
    this.attribute = attribute;
    this.value = value;
  }
  element(element) {
    if (this.value) element.setAttribute(this.attribute, this.value);
  }
}

class LinkAttributeHandler {
  constructor(href, title) {
    this.href = href;
    this.title = title;
  }
  element(element) {
    if (this.href) element.setAttribute("href", this.href);
    if (this.title) element.setAttribute("title", this.title);
  }
}

class DateAttributeHandler {
  constructor(readableDate, isoDate) {
    this.readable = readableDate;
    this.iso = isoDate;
  }
  element(element) {
    if (this.readable) element.setInnerContent(this.readable);
    if (this.iso) element.setAttribute("datetime", this.iso);
  }
}

class ImageHandler {
  constructor(src, alt) {
    this.src = src;
    this.alt = alt || "";
  }
  element(element) {
    if (this.src) {
      element.setAttribute("src", this.src);
      element.setAttribute("alt", this.alt);
      element.removeAttribute("srcset");
    }
  }
}

class SchemaHandler {
  constructor(post, datePublished, dateUpdated, url, desc) {
    this.post = post;
    this.published = datePublished;
    this.updated = dateUpdated;
    this.url = url;
    this.desc = desc;
  }
  element(element) {
    const schema = {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: this.post.title,
      description: this.desc,
      datePublished: this.published,
      dateModified: this.updated,
      mainEntityOfPage: { "@type": "WebPage", "@id": this.url },
      image: this.post.cover ? [this.post.cover] : [],
      author: [
        {
          "@type": "Person",
          name: "Silvan Soeters",
          url: "https://sil.so/author/silvan-soeters",
        },
      ],
    };
    element.setInnerContent(JSON.stringify(schema, null, 2), { html: true });
  }
}

class BlogListSchemaHandler {
  constructor(posts, url) {
    this.posts = posts;
    this.url = url;
  }
  element(element) {
    const schema = {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: "Blog",
      url: this.url,
      inLanguage: "en",
      description: "Blog articles and posts by Silvan Soeters",
      mainEntity: {
        "@type": "Blog",
        name: "Silvan Soeters Blog",
        author: {
          "@type": "Person",
          name: "Silvan Soeters",
          url: "https://sil.so",
          sameAs: [
            "https://x.com/silvansoeters",
            "https://www.linkedin.com/in/silvansoeters/",
            "https://bsky.app/profile/sil.so",
            "https://www.instagram.com/silvansoeters/",
            "https://threads.com/@silvansoeters",
            "https://github.com/sil-so",
          ],
        },
        blogPost: this.posts.map((post) => ({
          "@type": "BlogPosting",
          headline: post.title,
          description: post.description,
          datePublished: post.date,
          url: `${this.url}/${post.slug}`,
          image: post.cover
            ? {
                "@type": "ImageObject",
                url: post.cover,
              }
            : undefined,
          author: {
            "@type": "Person",
            name: "Silvan Soeters",
          },
        })),
      },
    };
    element.setInnerContent(JSON.stringify(schema, null, 2), { html: true });
  }
}
