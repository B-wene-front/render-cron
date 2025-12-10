import logger from '../utils/logger';
import puppeteer, { Browser, Page } from 'puppeteer';
import { parse } from 'node-html-parser';
import { convert } from 'html-to-text';
import { supabase } from '../config/database';
import { voyageai, VOYAGEAI_MODEL } from '../config/embedding';

interface TechCrunchArticle {
  url: string;
  title: string;
  category: string;
  author: string;
  publishedDate: string;
}

interface TechCrunchContent {
  title: string;
  rawHtml: string;  // Raw HTML for database storage
  cleanText: string; // Clean text for embedding generation
  publishedDate: string;
  category: string;
  author: string;
  tags: string[];
  featuredImage?: string; // Featured image URL if available
}

interface NewsData {
  url: string;
  title: string;
  content: string;
  source: string;
  published_date: Date;
  news_type: string;
  article_category: string;
  company_name: string;
  author?: string;
  publication: string;
  tags: string[];
  sentiment: string;
  impact_level: string;
  credibility_score: number;
  geographic_focus: string[];
  industry_focus: string[];
  related_companies: string[];
  metadata: any;
  word_count: number;
  language: string;
}

export class TechCrunchService {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private readonly SEARCH_URL = 'https://techcrunch.com/?s=';

  // Helper: Delay function
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Helper: Check if record exists
  private async recordExists(url: string): Promise<boolean> {
    try {
      const { count } = await supabase
        .from('news')
        .select('*', { count: 'exact', head: true })
        .eq('url', url);

      return (count || 0) > 0;
    } catch (error) {
      logger.warn(`Failed to check if record exists for URL ${url}:`, error);
      return false;
    }
  }

  // Helper: Generate embedding
  private async generateEmbedding(content: string, retries: number = 3): Promise<number[]> {
    const maxRetries = retries;
    let attempt = 0;
    
    while (attempt < maxRetries) {
      try {
        if (attempt > 0) {
          const backoffDelay = Math.min(20000 * Math.pow(2, attempt - 1), 60000);
          logger.info(`Waiting ${backoffDelay}ms before retry ${attempt + 1}/${maxRetries}...`);
          await this.delay(backoffDelay);
        } else {
          await this.delay(20000); // Initial delay to respect rate limits
        }
        
        const response = await voyageai.embed({
          input: [content],
          model: VOYAGEAI_MODEL!
        });
        return response.data?.[0]?.embedding || [];
      } catch (error: any) {
        attempt++;
        
        if (error?.statusCode === 429 || error?.message?.includes('429')) {
          if (attempt < maxRetries) {
            const retryAfter = error?.body?.retry_after || 20;
            const delay = retryAfter * 1000;
            logger.warn(`Rate limit hit (429). Retrying after ${delay}ms (attempt ${attempt}/${maxRetries})...`);
            await this.delay(delay);
            continue;
          } else {
            logger.error('Rate limit error after max retries:', error);
            throw new Error(`Rate limit exceeded after ${maxRetries} attempts. ${error?.body?.detail || error.message}`);
          }
        }
        
        logger.error('Error generating embedding:', error);
        throw error;
      }
    }
    
    throw new Error('Failed to generate embedding after all retries');
  }

  // Helper: Store news
  private async storeNews(newsData: NewsData, embedding: number[]): Promise<string> {
    try {
      const { data, error } = await supabase
        .from('news')
        .insert([{
          url: newsData.url,
          title: newsData.title,
          content: newsData.content,
          source: newsData.source,
          published_date: newsData.published_date.toISOString(),
          news_type: newsData.news_type,
          article_category: newsData.article_category,
          company_name: newsData.company_name,
          author: newsData.author,
          publication: newsData.publication,
          tags: newsData.tags,
          sentiment: newsData.sentiment,
          impact_level: newsData.impact_level,
          credibility_score: newsData.credibility_score,
          geographic_focus: newsData.geographic_focus,
          industry_focus: newsData.industry_focus,
          related_companies: newsData.related_companies,
          metadata: newsData.metadata,
          word_count: newsData.word_count,
          language: newsData.language,
          embedding: embedding
        }])
        .select('id')
        .single();

      if (error) {
        logger.error('Error storing news:', error);
        throw error;
      }

      return data.id;
    } catch (error) {
      logger.error('Error storing news:', error);
      throw error;
    }
  }

  // Helper: Calculate word count
  private calculateWordCount(content: string): number {
    return content.split(/\s+/).filter(word => word.length > 0).length;
  }

  // Helper: Analyze sentiment
  private analyzeSentiment(content: string): string {
    const lowerContent = content.toLowerCase();
    const positiveWords = ['success', 'achievement', 'milestone', 'partnership', 'innovation', 'breakthrough', 'approval', 'raises', 'funding'];
    const negativeWords = ['challenge', 'delay', 'issue', 'concern', 'risk', 'accident', 'crash', 'shuts down', 'bankruptcy'];

    const positiveCount = positiveWords.filter(word => lowerContent.includes(word)).length;
    const negativeCount = negativeWords.filter(word => lowerContent.includes(word)).length;

    if (positiveCount > negativeCount) return 'positive';
    if (negativeCount > positiveCount) return 'negative';
    return 'neutral';
  }

  // Helper: Assess impact level
  private assessImpactLevel(content: string): string {
    const lowerContent = content.toLowerCase();
    const highImpactWords = ['major', 'significant', 'milestone', 'historic', 'breakthrough', 'first', 'record', 'unveils', 'launches'];
    const highImpactCount = highImpactWords.filter(word => lowerContent.includes(word)).length;

    if (highImpactCount >= 2) return 'high';
    if (highImpactCount === 1) return 'medium';
    return 'low';
  }

  // Helper: Extract geographic focus
  private extractGeographicFocus(content: string): string[] {
    const lowerContent = content.toLowerCase();
    const locations: string[] = [];

    if (lowerContent.includes('united states') || lowerContent.includes('california') || lowerContent.includes('vermont') || lowerContent.includes('new york')) locations.push('United States');
    if (lowerContent.includes('europe') || lowerContent.includes('france') || lowerContent.includes('germany')) locations.push('Europe');
    if (lowerContent.includes('asia') || lowerContent.includes('japan') || lowerContent.includes('china')) locations.push('Asia');

    return [...new Set(locations)];
  }

  // Helper: Extract related companies
  private extractRelatedCompanies(content: string): string[] {
    const lowerContent = content.toLowerCase();
    const companies: string[] = [];

    const companyKeywords = [
      'joby', 'archer', 'beta technologies', 'wisk', 'overair',
      'jaunt', 'lift aircraft', 'volocopter', 'vertical aerospace',
      'lilium', 'ehang', 'kitty hawk'
    ];

    companyKeywords.forEach(keyword => {
      if (lowerContent.includes(keyword)) {
        companies.push(keyword.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
      }
    });

    return [...new Set(companies)];
  }

  /**
   * Initialize browser for TechCrunch crawling
   */
  private async initializeBrowser(): Promise<void> {
    try {
      logger.info('Initializing TechCrunch browser...');
      
      this.browser = await puppeteer.launch({
        headless: true, // Use headless for production
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--disable-blink-features=AutomationControlled',
          '--disable-features=IsolateOrigins,site-per-process',
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor',
          '--disable-permissions-api',
          '--disable-background-networking'
        ]
      });

      this.page = await this.browser.newPage();
      
      await this.page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      });
      
      await this.page.setViewport({ width: 1920, height: 1080 });
      this.page.setDefaultNavigationTimeout(120000);
      
      // Remove automation indicators
      await this.page.evaluateOnNewDocument(() => {
        const nav = (globalThis as any).navigator;
        const win = (globalThis as any).window;
        Object.defineProperty(nav, 'webdriver', { get: () => false });
        win.navigator.chrome = { runtime: {} };
        Object.defineProperty(nav, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(nav, 'languages', { get: () => ['en-US', 'en'] });
      });
      
      logger.info('TechCrunch browser initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize TechCrunch browser:', error);
      throw error;
    }
  }

  /**
   * Cleanup browser
   */
  private async cleanupBrowser(): Promise<void> {
    try {
      if (this.page) {
        await this.page.close();
        this.page = null;
      }
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
      logger.info('TechCrunch browser closed successfully');
    } catch (error) {
      logger.error('Error during TechCrunch browser cleanup:', error);
    }
  }

  /**
   * Handle TechCrunch popups (cookie consent, newsletter signup, etc.)
   */
  private async handleTechCrunchPopups(): Promise<void> {
    try {
      if (!this.page) return;
      
      await this.delay(2000);
      
      // Handle popups
      const handled = await this.page.evaluate(() => {
        const tryClick = (el: any) => {
          if (!el) return false;
          const win = (globalThis as any).window;
          const visible = (el.offsetParent !== null) || (win.getComputedStyle(el).display !== 'none');
          if (visible && typeof el.click === 'function') {
            el.click();
            return true;
          }
          return false;
        };

        // Close buttons
        const closeSelectors = [
          '[aria-label*="Close"]',
          'button[aria-label*="close"]',
          '.close',
          '.modal-close',
          'button[type="button"][class*="close"]'
        ];
        
        for (const sel of closeSelectors) {
          const btn = (globalThis as any).document.querySelector(sel);
          if (tryClick(btn)) return 'closed';
        }

        // Cookie consent (find by text)
        const clickByText = (selectors: string[], keywords: string[]): boolean => {
          const doc = (globalThis as any).document;
          for (const sel of selectors) {
            const nodes = Array.from(doc.querySelectorAll(sel)) as any[];
            for (const nodeEl of nodes) {
              const anyNode = nodeEl as any;
              const text = ((anyNode.textContent || '') as string).toLowerCase();
              if (!text) continue;
              if (keywords.some(k => text.includes(k))) {
                if (tryClick(anyNode)) return true;
              }
            }
          }
          return false;
        };

        const cookieAccepted = clickByText(['button', 'a'], ['accept', 'agree', 'consent', 'got it', 'continue']);
        if (cookieAccepted) return 'cookie-accepted';

        // Hide overlays
        const overlays = (globalThis as any).document.querySelectorAll('[role="dialog"], [class*="modal"], [id*="modal"], .newsletter, [class*="subscribe"], .tp-modal, .tp-backdrop');
        overlays.forEach((el: any) => {
          if (el.style) {
            el.style.setProperty('display', 'none', 'important');
            el.style.setProperty('visibility', 'hidden', 'important');
          }
        });

        return false;
      });
      
      if (handled) {
        logger.info(`Handled TechCrunch popup: ${handled}`);
        await this.delay(500);
      }
      
    } catch (error) {
      logger.debug('No popups found or already dismissed');
    }
  }

  /**
   * Search TechCrunch for a company and extract top 5 articles
   */
  async searchCompany(companyName: string): Promise<TechCrunchArticle[]> {
    logger.info(`\n=== Searching TechCrunch for: ${companyName} ===`);
    
    const searchQuery = companyName.replace(/\s+/g, '+');
    const searchUrl = `${this.SEARCH_URL}${searchQuery}`;
    
    try {
      if (!this.page) {
        await this.initializeBrowser();
      }

      logger.info(`Navigating to: ${searchUrl}`);
      
      await this.page!.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      
      // Handle popups
      await this.handleTechCrunchPopups();
      
      // Wait for search results
      try {
        await this.page!.waitForSelector('ul.wp-block-post-template, .wp-block-post', { timeout: 15000 });
      } catch {}
      
      await this.delay(2000);
      
      // Extract articles
      const articles = await this.page!.evaluate((): TechCrunchArticle[] => {
        const results: TechCrunchArticle[] = [];
        const doc = (globalThis as any).document;
        
        // Get article list items (prefer main results list)
        const list = doc.querySelector('ul.wp-block-post-template');
        const articleElements = list ? list.querySelectorAll('li.wp-block-post') : doc.querySelectorAll('li.wp-block-post, .wp-block-post');
        
        for (let i = 0; i < Math.min(articleElements.length, 5); i++) {
          const article = articleElements[i];
          
          // Extract URL strictly from the title link (avoid category/author links)
          const linkEl = (article.querySelector('h3 .loop-card__title-link')
            || article.querySelector('h3 a.loop-card__title-link')
            || article.querySelector('h3 a')) as any;
          const url = (linkEl?.getAttribute('href') || linkEl?.getAttribute('data-destinationlink') || '').trim();
          
          // Skip non-article URLs (category/tag pages, pagination, etc.)
          if (!url || !url.startsWith('http')) continue;
          if (url.includes('/category/') || url.includes('/tag/') || url.includes('/page/')) continue;
          if (!/\/20\d{2}\//.test(url)) continue; // ensure article permalink with year
          
          // Extract title
          const title = ((linkEl?.textContent || '') as string).trim();
          
          // Extract category
          const categoryEl = article.querySelector('.loop-card__cat');
          const category = categoryEl?.textContent?.trim() || '';
          
          // Extract author
          const authorEl = article.querySelector('.loop-card__author');
          const author = authorEl?.textContent?.trim() || '';
          
          // Extract published date
          const timeEl = article.querySelector('time');
          const publishedDate = timeEl?.getAttribute('datetime') || timeEl?.textContent?.trim() || '';
          
          if (url && title) {
            results.push({ url, title, category, author, publishedDate });
          }
        }
        
        return results;
      });
      
      logger.info(`Found ${articles.length} articles for ${companyName}`);
      return articles;
      
    } catch (error) {
      logger.error(`Failed to search TechCrunch for ${companyName}:`, error);
      return [];
    }
  }

  /**
   * Fetch article content from TechCrunch
   */
  async fetchArticleContent(url: string): Promise<TechCrunchContent | null> {
    try {
      if (!this.page) {
        await this.initializeBrowser();
      }

      logger.info(`Fetching TechCrunch article: ${url}`);
      
      await this.page!.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      
      // Handle popups
      await this.handleTechCrunchPopups();
      
      // Wait for content
      try {
        await this.page!.waitForSelector('.entry-content, article', { timeout: 15000 });
      } catch {}
      
      await this.delay(1500);
      
      // Extract content
      const pageData = await this.page!.evaluate(() => {
        const doc = (globalThis as any).document;
        
        // Title
        const titleEl = doc.querySelector('h1.wp-block-post-title, h1.post-title, h1');
        const title = titleEl?.textContent?.trim() || '';
        
        // Content - get raw HTML
        const contentEl = doc.querySelector('div.entry-content.wp-block-post-content, .entry-content, .wp-block-post-content, article');
        const rawHTML = contentEl?.innerHTML || '';
        
        // Extract featured image
        let featuredImage = '';
        const featuredImgEl = doc.querySelector('img.wp-post-image, .wp-block-post-featured-image img, article img:first-of-type');
        if (featuredImgEl) {
          featuredImage = featuredImgEl.getAttribute('src') || featuredImgEl.getAttribute('data-src') || '';
        }
        // Fallback: try meta tag
        if (!featuredImage) {
          const metaImg = doc.querySelector('meta[property="og:image"]');
          if (metaImg) {
            featuredImage = metaImg.getAttribute('content') || '';
          }
        }
        
        // Category
        const categoryFromMeta = doc.querySelector('meta[property="article:section"]')?.getAttribute('content') || '';
        const categoryEl = doc.querySelector('.wp-block-tc23-post-byline__category a, .category, .loop-card__cat');
        const category = (categoryEl?.textContent?.trim() || categoryFromMeta || '').trim();
        
        // Author
        const authorEl = doc.querySelector('a[rel="author"], .wp-block-tc23-post-byline__author a, .author-name');
        const author = authorEl?.textContent?.trim() || (doc.querySelector('meta[name="author"]')?.getAttribute('content') || '');
        
        // Published date
        const timeEl = doc.querySelector('time[datetime], time');
        const publishedDate = timeEl?.getAttribute('datetime') || doc.querySelector('meta[property="article:published_time"]')?.getAttribute('content') || timeEl?.textContent?.trim() || '';
        
        // Tags
        const tagElements = doc.querySelectorAll('a[rel="tag"], .wp-block-tc23-post-relevant-terms a[rel="tag"]');
        const tags = Array.from(tagElements).map((el: any) => el.textContent?.trim() || '').filter(Boolean);
        
        return { title, rawHTML, category, author, publishedDate, tags, featuredImage };
      });

      if (!pageData.title || !pageData.rawHTML) {
        logger.warn(`No content found for: ${url}`);
        return null;
      }

      // Prepend featured image to raw HTML if it exists
      let fullRawHTML = pageData.rawHTML;
      if (pageData.featuredImage) {
        fullRawHTML = `<img src="${pageData.featuredImage}" alt="${pageData.title}" />\n${pageData.rawHTML}`;
      }

      // Parse and clean HTML for embedding generation only
      const root = parse(pageData.rawHTML);
      
      const unwantedSelectors = [
        'script', 'style', 'noscript', 'svg', 'img', 'button', 'figure', 'figcaption',
        'nav', 'header', 'footer', 'aside', '.ad-unit', '.inline-cta', '.inline-cta__wrapper',
        '.wp-block-techcrunch-inline-cta', '.wp-block-techcrunch-social-share', '.wp-block-tc-ads-ad-slot'
      ];
      
      unwantedSelectors.forEach(selector => {
        root.querySelectorAll(selector).forEach(el => el.remove());
      });
      
      const content = root.text
        .replace(/\s+/g, ' ')
        .replace(/\n+/g, '\n')
        .trim();

      const fallbackContent = convert(pageData.rawHTML, {
        wordwrap: 0,
        selectors: [
          { selector: 'a', options: { ignoreHref: true } },
          { selector: 'img', format: 'skip' },
          { selector: 'script', format: 'skip' },
          { selector: 'style', format: 'skip' },
          { selector: '.ad-unit', format: 'skip' },
          { selector: '.inline-cta', format: 'skip' },
          { selector: '.wp-block-techcrunch-inline-cta', format: 'skip' },
          { selector: 'figure', format: 'skip' },
          { selector: 'figcaption', format: 'skip' },
          { selector: 'br', format: 'lineBreak' },
          { selector: 'p', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
        ],
      }).trim();

      const cleanText = content.length >= 80 ? content : fallbackContent;

      return {
        title: pageData.title,
        rawHtml: fullRawHTML,  // Store raw HTML in database (includes featured image if present)
        cleanText: cleanText,       // Use clean text for embedding
        publishedDate: pageData.publishedDate,
        category: pageData.category,
        author: pageData.author,
        tags: pageData.tags as string[],
        featuredImage: pageData.featuredImage || undefined
      };

    } catch (error) {
      logger.error(`Failed to fetch TechCrunch article from ${url}:`, error);
      return null;
    }
  }

  /**
   * Process and store a single article
   */
  async processAndStoreArticle(article: TechCrunchArticle, companyName: string): Promise<boolean> {
    try {
      const exists = await this.recordExists(article.url);
      if (exists) {
        logger.info(`Content already exists, skipping: ${article.url}`);
        return false;
      }

      const fullContent = await this.fetchArticleContent(article.url);
      if (!fullContent) {
        logger.warn(`Failed to fetch content for: ${article.url}`);
        return false;
      }

      if (!fullContent.rawHtml || fullContent.rawHtml.trim().length === 0) {
        logger.warn(`No meaningful content found for: ${article.url}`);
        return false;
      }

      // Use clean text for word count and analysis
      const wordCount = this.calculateWordCount(fullContent.cleanText);

      // Ensure popups are dismissed before generating embeddings
      try {
        await this.handleTechCrunchPopups();
      } catch {}

      logger.info(`Generating embedding for: ${fullContent.title} (${wordCount} words)`);
      let embedding: number[] | undefined;
      try {
        embedding = await this.generateEmbedding(fullContent.cleanText);
      } catch (err) {
        logger.warn('Embedding generation failed, proceeding to store without embedding', err);
        embedding = [];
      }

      const newsData: NewsData = {
        url: article.url,
        title: fullContent.title,
        content: fullContent.rawHtml,  // Store raw HTML in content field
        source: 'techcrunch',
        published_date: this.parseTechCrunchDate(fullContent.publishedDate),
        news_type: 'news',
        article_category: 'industry_news',
        company_name: companyName,
        author: fullContent.author,
        publication: 'TechCrunch',
        tags: fullContent.tags,
        sentiment: this.analyzeSentiment(fullContent.cleanText),  // Use clean text for analysis
        impact_level: this.assessImpactLevel(fullContent.cleanText),  // Use clean text for analysis
        credibility_score: 0.85,
        geographic_focus: this.extractGeographicFocus(fullContent.cleanText),  // Use clean text for analysis
        industry_focus: ['eVTOL', 'Urban Air Mobility', 'Aviation', 'Tech'],
        related_companies: this.extractRelatedCompanies(fullContent.cleanText),  // Use clean text for analysis
        metadata: {
          source: 'techcrunch',
          url: article.url,
          category: fullContent.category,
          author: fullContent.author,
          tags: fullContent.tags,
          embedding_generated: !!embedding && embedding.length > 0,
          embedding_model: VOYAGEAI_MODEL!,
          table_name: 'news',
          word_count: wordCount,
          featured_image: fullContent.featuredImage || null
        },
        word_count: wordCount,
        language: 'en'
      };

      const documentId = await this.storeNews(newsData, embedding || []);
      logger.info(`Successfully stored TechCrunch article: ${documentId} - ${fullContent.title}`);

      return true;

    } catch (error) {
      logger.error(`Failed to process TechCrunch article "${article.title}":`, error);
      return false;
    }
  }

  /**
   * Parse TechCrunch date format
   */
  private parseTechCrunchDate(dateString: string): Date {
    try {
      const date = new Date(dateString);
      if (!isNaN(date.getTime())) {
        return date;
      }
      return new Date();
    } catch {
      return new Date();
    }
  }

  /**
   * Process all eVTOL companies
   */
  async processAllCompanies(companies: string[]): Promise<any> {
    logger.info('Processing TechCrunch news for all eVTOL companies...');
    
    try {
      await this.initializeBrowser();
      
      const allResults = [];
      
      for (const companyName of companies) {
        try {
          logger.info(`\n=== Processing ${companyName} ===`);
          
          const articles = await this.searchCompany(companyName);
          
          let processedCount = 0;
          let skippedCount = 0;
          let failedCount = 0;
          const processedArticles = [];
          
          for (const article of articles) {
            try {
              logger.info(`Processing: ${article.title}`);
              
              const processed = await this.processAndStoreArticle(article, companyName);
              
              if (processed) {
                processedCount++;
                processedArticles.push({
                  url: article.url,
                  title: article.title,
                  category: article.category,
                  publishedDate: article.publishedDate
                });
              } else {
                skippedCount++;
              }
              
              // Delay between requests
              await this.delay(3000);
              
            } catch (error) {
              logger.error(`Failed to process article: ${article.title}`, error);
              failedCount++;
            }
          }
          
          allResults.push({
            company: companyName,
            totalArticles: articles.length,
            processed: processedCount,
            skipped: skippedCount,
            failed: failedCount,
            articles: processedArticles
          });
          
          // Delay between companies
          await this.delay(5000);
          
        } catch (error) {
          logger.error(`Failed to process company ${companyName}:`, error);
          allResults.push({
            company: companyName,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }
      
      await this.cleanupBrowser();
      
      logger.info(`\n=== TechCrunch processing complete ===`);
      logger.info(`Processed ${allResults.length} companies`);
      
      return {
        source: 'TechCrunch',
        totalCompanies: allResults.length,
        results: allResults
      };

    } catch (error) {
      logger.error('Failed to process TechCrunch news:', error);
      throw error;
    }
  }

  /**
   * Process single company
   */
  async processSingleCompany(companyName: string): Promise<any> {
    logger.info(`Processing TechCrunch news for ${companyName}...`);
    
    try {
      await this.initializeBrowser();
      
      const articles = await this.searchCompany(companyName);
      
      let processedCount = 0;
      let skippedCount = 0;
      let failedCount = 0;
      const processedArticles = [];
      
      for (const article of articles) {
        try {
          logger.info(`Processing: ${article.title}`);
          
          const processed = await this.processAndStoreArticle(article, companyName);
          
          if (processed) {
            processedCount++;
            processedArticles.push({
              url: article.url,
              title: article.title,
              category: article.category,
              publishedDate: article.publishedDate
            });
          } else {
            skippedCount++;
          }
          
          await this.delay(3000);
          
        } catch (error) {
          logger.error(`Failed to process article: ${article.title}`, error);
          failedCount++;
        }
      }
      
      await this.cleanupBrowser();
      
      const summary = {
        company: companyName,
        source: 'TechCrunch',
        totalArticles: articles.length,
        processed: processedCount,
        skipped: skippedCount,
        failed: failedCount,
        articles: processedArticles
      };

      logger.info(`\n=== TechCrunch processing complete for ${companyName} ===`);
      logger.info(`Total: ${articles.length}, Processed: ${processedCount}, Skipped: ${skippedCount}, Failed: ${failedCount}`);
      
      return summary;

    } catch (error) {
      logger.error(`Failed to process TechCrunch news for ${companyName}:`, error);
      throw error;
    }
  }
}

// Export singleton instance
export const techcrunchService = new TechCrunchService();

