import puppeteer, { Browser, Page } from 'puppeteer';
import { parse } from 'node-html-parser';
import { convert } from 'html-to-text';
import { supabase } from '../config/database';
import { voyageai, VOYAGEAI_MODEL } from '../config/embedding';
import logger from '../utils/logger';

interface WiskNewsArticle {
  url: string;
  title: string;
  publishedDate: string;
  categories: string[]; // e.g., ['Blog'], ['Press Release', 'Featured']
}

interface WiskNewsContent {
  title: string;
  rawHtml: string;  // Raw HTML for database storage
  cleanText: string; // Clean text for embedding generation
  publishedDate: string;
  categories: string[];
  featuredImage?: string; // Featured image URL (between title and content)
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

export class WiskAeroService {
  private newsBrowser: Browser | null = null;
  private newsPage: Page | null = null;
  private readonly NEWSROOM_BASE_URL = 'https://wisk.aero/newsroom';
  private readonly COMPANY_NAME = 'Wisk Aero';

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
    const positiveWords = ['success', 'achievement', 'milestone', 'partnership', 'innovation', 'breakthrough', 'approval', 'advance'];
    const negativeWords = ['challenge', 'delay', 'issue', 'concern', 'risk'];

    const positiveCount = positiveWords.filter(word => lowerContent.includes(word)).length;
    const negativeCount = negativeWords.filter(word => lowerContent.includes(word)).length;

    if (positiveCount > negativeCount) return 'positive';
    if (negativeCount > positiveCount) return 'negative';
    return 'neutral';
  }

  // Helper: Assess impact level
  private assessImpactLevel(content: string): string {
    const lowerContent = content.toLowerCase();
    const highImpactWords = ['major', 'significant', 'milestone', 'historic', 'breakthrough', 'first', 'record'];
    const highImpactCount = highImpactWords.filter(word => lowerContent.includes(word)).length;

    if (highImpactCount >= 2) return 'high';
    if (highImpactCount === 1) return 'medium';
    return 'low';
  }

  // Helper: Extract geographic focus
  private extractGeographicFocus(content: string): string[] {
    const lowerContent = content.toLowerCase();
    const locations: string[] = [];

    if (lowerContent.includes('california') || lowerContent.includes('los angeles') || lowerContent.includes('fullerton') || lowerContent.includes('long beach')) locations.push('United States');
    if (lowerContent.includes('texas') || lowerContent.includes('houston') || lowerContent.includes('sugar land')) locations.push('United States');
    if (lowerContent.includes('miami') || lowerContent.includes('florida')) locations.push('United States');
    if (lowerContent.includes('japan') || lowerContent.includes('kaga')) locations.push('Japan');
    if (lowerContent.includes('australia') || lowerContent.includes('queensland') || lowerContent.includes('brisbane')) locations.push('Australia');
    if (lowerContent.includes('new zealand') || lowerContent.includes('christchurch')) locations.push('New Zealand');

    return [...new Set(locations)];
  }

  // Helper: Extract related companies
  private extractRelatedCompanies(content: string): string[] {
    const lowerContent = content.toLowerCase();
    const companies: string[] = ['Wisk Aero'];

    if (lowerContent.includes('boeing')) companies.push('Boeing');
    if (lowerContent.includes('japan airlines') || lowerContent.includes('jal')) companies.push('Japan Airlines');
    if (lowerContent.includes('skyports')) companies.push('Skyports');
    if (lowerContent.includes('signature aviation')) companies.push('Signature Aviation');
    if (lowerContent.includes('skygrid')) companies.push('SkyGrid');
    if (lowerContent.includes('airservices australia')) companies.push('Airservices Australia');
    if (lowerContent.includes('nasa')) companies.push('NASA');

    return [...new Set(companies)];
  }

  // Helper: Generate tags
  private generateTags(content: string, categories: string[]): string[] {
    const tags: string[] = [...categories];
    const lowerContent = content.toLowerCase();
    
    const tagMappings = [
      { keywords: ['air taxi', 'air taxi service'], tag: 'air taxi' },
      { keywords: ['evtol', 'e-vtol'], tag: 'eVTOL' },
      { keywords: ['generation 6', 'gen 6'], tag: 'Generation 6' },
      { keywords: ['autonomous', 'self-flying'], tag: 'autonomous flight' },
      { keywords: ['vertiport'], tag: 'vertiport' },
      { keywords: ['faa'], tag: 'FAA certification' },
      { keywords: ['flight test'], tag: 'flight testing' },
      { keywords: ['partnership'], tag: 'partnership' },
      { keywords: ['urban air mobility', 'uam'], tag: 'urban air mobility' },
      { keywords: ['certification'], tag: 'certification' },
    ];

    for (const mapping of tagMappings) {
      if (mapping.keywords.some(keyword => lowerContent.includes(keyword))) {
        if (!tags.includes(mapping.tag)) {
          tags.push(mapping.tag);
        }
      }
    }

    return tags;
  }

  // Helper: Parse Wisk date format (e.g., "Sep 17, 2025")
  private parseWiskDate(dateString: string): Date {
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
   * Initialize browser for news crawling
   */
  private async initializeNewsBrowser(): Promise<void> {
    try {
      logger.info('Initializing Wisk News browser...');
      
      this.newsBrowser = await puppeteer.launch({
        headless: true, // Use headless for production
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--disable-blink-features=AutomationControlled',
          '--disable-features=IsolateOrigins,site-per-process'
        ]
      });

      this.newsPage = await this.newsBrowser.newPage();
      
      await this.newsPage.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      });
      
      await this.newsPage.setViewport({ width: 1920, height: 1080 });
      this.newsPage.setDefaultNavigationTimeout(120000);
      
      await this.newsPage.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      );
      
      // Remove automation indicators
      await this.newsPage.evaluateOnNewDocument(() => {
        // @ts-ignore
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        // @ts-ignore
        window.navigator.chrome = { runtime: {} };
        // @ts-ignore
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        // @ts-ignore
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      });
      
      logger.info('News browser initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize news browser:', error);
      throw error;
    }
  }

  /**
   * Cleanup news browser
   */
  private async cleanupNewsBrowser(): Promise<void> {
    try {
      if (this.newsPage) {
        await this.newsPage.close();
        this.newsPage = null;
      }
      if (this.newsBrowser) {
        await this.newsBrowser.close();
        this.newsBrowser = null;
      }
      logger.info('News browser closed successfully');
    } catch (error) {
      logger.error('Error during news browser cleanup:', error);
    }
  }

  /**
   * Handle HubSpot cookie consent for Wisk pages
   */
  private async handleWiskCookieConsent(): Promise<void> {
    try {
      if (!this.newsPage) return;
      
      await this.delay(1500);
      
      const acceptClicked = await this.newsPage.evaluate(() => {
        // @ts-ignore
        const acceptBtn = document.querySelector('#hs-eu-confirmation-button');
        if (acceptBtn) {
          (acceptBtn as any).click();
          return true;
        }
        return false;
      });
      
      if (acceptClicked) {
        logger.info('Clicked cookie consent');
        await this.delay(1000);
      }
    } catch (error) {
      logger.debug('No cookie consent found or already accepted');
    }
  }

  /**
   * Click "Load More" button for a specific section until it disappears
   */
  private async loadMoreArticlesForSection(sectionId: string, sectionName: string): Promise<void> {
    let loadMoreAttempts = 0;
    const maxLoadMoreAttempts = 100;
    
    while (loadMoreAttempts < maxLoadMoreAttempts) {
      try {
        await this.delay(2000);
        
        // Find "Load More" button in the specific section
        const loadMoreButton = await this.newsPage!.evaluate((sectionId) => {
          // @ts-ignore - browser context
          const section = document.querySelector(`#${sectionId}`);
          if (!section) return null;
          
          // Find "Load More" button within this section
          // @ts-ignore - browser context
          const buttons = Array.from(section.querySelectorAll('div[data-framer-name="Load More"], button, div[class*="Load More"]'));
          const loadMoreBtn = buttons.find((btn: any) => {
            const text = btn.textContent?.trim() || '';
            return text === 'Load More' || text.includes('Load More');
          }) as any;
          
          if (loadMoreBtn) {
            loadMoreBtn.setAttribute('data-load-more', 'true');
            return true;
          }
          return false;
        }, sectionId);
        
        if (!loadMoreButton) {
          logger.info(`No "Load More" button found in ${sectionName} - all articles loaded`);
          break;
        }

        logger.info(`Clicking "Load More" button in ${sectionName} (attempt ${loadMoreAttempts + 1})...`);
        
        // Get current article count
        const articleCountBefore = await this.newsPage!.evaluate((sectionId) => {
          // @ts-ignore - browser context
          const section = document.querySelector(`#${sectionId}`);
          if (!section) return 0;
          // Count article containers
          // @ts-ignore - browser context
          return section.querySelectorAll('a[href*="newsroom"], a[href*="./newsroom"]').length;
        }, sectionId);
        
        // Click the button
        await this.newsPage!.evaluate((sectionId) => {
          // @ts-ignore - browser context
          const section = document.querySelector(`#${sectionId}`);
          if (!section) return;
          // @ts-ignore - browser context
          const button = section.querySelector('[data-load-more="true"]') as any;
          if (button) {
            button.click();
          }
        }, sectionId);
        
        await this.delay(3000);
        
        // Get article count after clicking
        const articleCountAfter = await this.newsPage!.evaluate((sectionId) => {
          // @ts-ignore - browser context
          const section = document.querySelector(`#${sectionId}`);
          if (!section) return 0;
          // @ts-ignore - browser context
          return section.querySelectorAll('a[href*="newsroom"], a[href*="./newsroom"]').length;
        }, sectionId);
        
        loadMoreAttempts++;
        
        logger.info(`Articles before: ${articleCountBefore}, after: ${articleCountAfter}`);
        
        if (articleCountAfter === articleCountBefore) {
          logger.info(`No new articles loaded in ${sectionName} - all articles loaded`);
          break;
        }
        
      } catch (error) {
        logger.error(`Error during Load More attempt ${loadMoreAttempts + 1} for ${sectionName}:`, error);
        break;
      }
    }

    logger.info(`Completed loading ${sectionName} articles after ${loadMoreAttempts} "Load More" clicks`);
  }

  /**
   * Extract articles from a specific section on the newsroom page
   */
  private async extractArticlesFromSection(sectionId: string, sectionName: string, category: string): Promise<WiskNewsArticle[]> {
    const articles = await this.newsPage!.evaluate((sectionId, category): WiskNewsArticle[] => {
      // @ts-ignore - browser context
      const section = document.querySelector(`#${sectionId}`);
      if (!section) return [];
      
      const articles: WiskNewsArticle[] = [];
      
      // Find all article links in this section
      // @ts-ignore - browser context
      const articleLinks = section.querySelectorAll('a[href*="newsroom"], a[href*="./newsroom"]');
      
      articleLinks.forEach((link: any) => {
        const href = link.getAttribute('href') || '';
        if (!href || href.includes('brandfolder') || href.includes('vimeo')) return; // Skip media kit and video links
        
        // Construct full URL
        let fullUrl = href;
        if (href.startsWith('./newsroom/')) {
          fullUrl = `https://wisk.aero${href.substring(1)}`;
        } else if (href.startsWith('/newsroom/')) {
          fullUrl = `https://wisk.aero${href}`;
        } else if (href.startsWith('newsroom/')) {
          fullUrl = `https://wisk.aero/${href}`;
        } else if (href.startsWith('http')) {
          // External link (news coverage), keep as is
          fullUrl = href;
        } else if (!href.startsWith('http')) {
          fullUrl = `https://wisk.aero/newsroom/${href}`;
        }
        
        // Extract title
        // @ts-ignore - browser context
        const titleEl = link.querySelector('h3.framer-text, h3[data-styles-preset="EPE_8qsds"]');
        const title = titleEl?.textContent?.trim() || '';
        
        // Extract date
        // @ts-ignore - browser context
        const dateEl = link.querySelector('p.framer-text');
        let publishedDate = '';
        if (dateEl) {
          const dateText = dateEl.textContent?.trim() || '';
          // Match date patterns like "Oct 28, 2025" or "Dec 1, 2025"
          const dateMatch = dateText.match(/([A-Za-z]{3}\s+\d{1,2},\s+\d{4})/);
          if (dateMatch) {
            publishedDate = dateMatch[1];
          } else {
            publishedDate = dateText;
          }
        }
        
        // Determine categories based on section
        const categories: string[] = [category];
        
        if (title && fullUrl) {
          articles.push({ url: fullUrl, title, publishedDate, categories });
        }
      });
      
      return articles;
    }, sectionId, category);
    
    // Remove duplicates
    const uniqueArticles = articles.filter((article, index, self) => 
      index === self.findIndex(a => a.url === article.url)
    );
    
    logger.info(`Extracted ${uniqueArticles.length} unique articles from ${sectionName}`);
    
    return uniqueArticles;
  }

  /**
   * Fetch article content from individual page
   */
  async fetchArticleContentDirect(url: string): Promise<WiskNewsContent | null> {
    try {
      if (!this.newsPage) {
        await this.initializeNewsBrowser();
      }

      logger.info(`Fetching content from: ${url}`);
      
      // Navigate with retry
      let navigationSuccess = false;
      let retries = 3;
      
      while (retries > 0 && !navigationSuccess) {
        try {
          await this.newsPage!.goto(url);
          navigationSuccess = true;
        } catch (error) {
          retries--;
          logger.warn(`Article navigation failed, retries remaining: ${retries}`);
          if (retries > 0) {
            await this.delay(2000);
          } else {
            throw error;
          }
        }
      }

      // Handle cookie consent
      await this.handleWiskCookieConsent();
      
      // Wait for content - try both old and new selectors
      try {
        await this.newsPage!.waitForSelector('.framer-hryg1w, .et_pb_post_content, .entry-content, h1, h4', { timeout: 15000 });
      } catch {}
      
      await this.delay(1500);

      // Extract content - support both old and new page structures
      const pageData = await this.newsPage!.evaluate(() => {
        // Try new structure first (Framer-based)
        // @ts-ignore - browser context
        const newContentEl = document.querySelector('.framer-hryg1w, section[data-framer-name="Content"]');
        if (newContentEl) {
          // @ts-ignore - browser context
          const titleEl = document.querySelector('h4.framer-text, h1.framer-text, h4[data-styles-preset="1xmo752"]');
          const title = titleEl?.textContent?.trim() || '';
          
          const rawHTML = newContentEl.innerHTML || '';
          
          // Extract date from info section
          // @ts-ignore - browser context
          const dateEl = document.querySelector('.framer-1adalsi, .framer-nou6np');
          let publishedDate = '';
          if (dateEl) {
            const dateText = dateEl.textContent?.trim() || '';
            const dateMatch = dateText.match(/([A-Za-z]{3,}\s+\d{1,2},\s+\d{4})/);
            if (dateMatch) {
              publishedDate = dateMatch[1];
            } else {
              publishedDate = dateText;
            }
          }
          
          // Extract categories from info section
          const categories: string[] = [];
          // @ts-ignore - browser context
          const categoryEl = document.querySelector('.framer-1adalsi');
          if (categoryEl) {
            const categoryText = categoryEl.textContent?.trim() || '';
            if (categoryText.includes('Press Release')) categories.push('Press Release');
            if (categoryText.includes('Blog')) categories.push('Blog');
            if (categoryText.includes('White Paper')) categories.push('White Paper');
          }
          
          // Extract featured image
          let featuredImage = '';
          // @ts-ignore - browser context
          const imgEl = document.querySelector('img[src*="framerusercontent"], img[src*="wisk"]');
          if (imgEl) {
            featuredImage = imgEl.src || imgEl.getAttribute('src') || '';
          }
          
          if (title && rawHTML) {
            return { title, rawHTML, publishedDate, categories, featuredImage };
          }
        }
        
        // Fallback to old structure
        // @ts-ignore - browser context
        const titleEl = document.querySelector('h1.entry-title, h1');
        const title = titleEl?.textContent?.trim() || '';
        
        // @ts-ignore - browser context
        const contentEl = document.querySelector('.et_pb_post_content, .entry-content, article');
        const rawHTML = contentEl?.innerHTML || '';
        
        // Try multiple selectors for published date
        // @ts-ignore - browser context
        let publishedDate = document.querySelector('.et_pb_text_inner')?.textContent?.trim() || '';
        if (!publishedDate || publishedDate.length < 5) {
          // @ts-ignore - browser context
          publishedDate = document.querySelector('.post-meta .published, .published')?.textContent?.trim() || '';
        }
        
        // @ts-ignore - browser context
        const categoryEls = document.querySelectorAll('.post-meta a[rel="tag"]');
        const categories: string[] = [];
        categoryEls.forEach((cat: any) => {
          categories.push(cat.textContent?.trim() || '');
        });
        
        // Extract featured image between title and content
        let featuredImage = '';
        if (titleEl && contentEl) {
          // Get the parent container
          const parentContainer = titleEl.parentElement || contentEl.parentElement;
          if (parentContainer) {
            // Find the image that's between title and content
            const titleIndex = Array.from(parentContainer.children).indexOf(titleEl);
            const contentIndex = Array.from(parentContainer.children).indexOf(contentEl);
            
            // Look for images between title and content
            for (let i = titleIndex + 1; i < contentIndex; i++) {
              const child = parentContainer.children[i];
              if (child.tagName === 'IMG') {
                const img = child as any;
                const src = img.src || img.getAttribute('src') || '';
                if (src && (src.includes('wisk.aero') || src.includes('http'))) {
                  featuredImage = src;
                  break;
                }
              }
            }
            
            // Fallback: if no image found between, check all images in parent
            if (!featuredImage) {
              const img = parentContainer.querySelector('img');
              if (img) {
                const src = img.src || img.getAttribute('src') || '';
                if (src && (src.includes('wisk.aero') || src.includes('http'))) {
                  featuredImage = src;
                }
              }
            }
          }
        }
        
        return { title, rawHTML, publishedDate, categories, featuredImage };
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

      // Parse HTML to clean text (for embedding generation only)
      const root = parse(pageData.rawHTML);
      
      const unwantedSelectors = [
        'script', 'style', 'noscript', 'svg', 'img', 'button', 
        'nav', 'header', 'footer', 'aside', '.et_social_share'
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
        categories: pageData.categories,
        featuredImage: pageData.featuredImage || undefined
      };

    } catch (error) {
      logger.error(`Failed to fetch content from ${url}:`, error);
      return null;
    }
  }

  /**
   * Process and store a single article
   */
  async processAndStoreArticle(article: WiskNewsArticle): Promise<boolean> {
    try {
      const exists = await this.recordExists(article.url);
      if (exists) {
        logger.info(`Content already exists, skipping: ${article.url}`);
        return false;
      }

      const fullContent = await this.fetchArticleContentDirect(article.url);
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

      // Determine news type based on categories
      let newsType = 'press_release';
      let articleCategory = 'press_release';
      
      const categoriesLower = fullContent.categories.map(c => c.toLowerCase());
      if (categoriesLower.some(c => c.includes('blog'))) {
        newsType = 'blog_post';
        articleCategory = 'blog_post';
      } else if (categoriesLower.some(c => c.includes('white paper') || c.includes('whitepaper'))) {
        newsType = 'whitepaper';
        articleCategory = 'whitepaper';
      } else if (categoriesLower.some(c => c.includes('press'))) {
        newsType = 'press_release';
        articleCategory = 'press_release';
      } else if (categoriesLower.some(c => c.includes('news'))) {
        newsType = 'news';
        articleCategory = 'news';
      }

      // Generate embedding from clean text only
      logger.info(`Generating embedding for: ${fullContent.title} (${wordCount} words)`);
      const embedding = await this.generateEmbedding(fullContent.cleanText);

      const newsData: NewsData = {
        url: article.url,
        title: fullContent.title,
        content: fullContent.rawHtml,  // Store raw HTML in content field
        source: 'wisk_aero',
        published_date: this.parseWiskDate(fullContent.publishedDate),
        news_type: newsType,
        article_category: articleCategory,
        company_name: this.COMPANY_NAME,
        publication: 'Wisk Aero',
        tags: this.generateTags(fullContent.cleanText, fullContent.categories),  // Use clean text for analysis
        sentiment: this.analyzeSentiment(fullContent.cleanText),
        impact_level: this.assessImpactLevel(fullContent.cleanText),
        credibility_score: 0.95,
        geographic_focus: this.extractGeographicFocus(fullContent.cleanText),
        industry_focus: ['eVTOL', 'Urban Air Mobility', 'Aviation', 'Autonomous Flight'],
        related_companies: this.extractRelatedCompanies(fullContent.cleanText),
        metadata: {
          snippet: fullContent.title,
          published_date: fullContent.publishedDate,
          source: 'wisk_aero',
          url: article.url,
          category: articleCategory,
          news_type: newsType,
          categories: fullContent.categories,
          embedding_generated: true,
          embedding_model: VOYAGEAI_MODEL!,
          table_name: 'news',
          word_count: wordCount,
          featured_image: fullContent.featuredImage || null
        },
        word_count: wordCount,
        language: 'en'
      };

      const documentId = await this.storeNews(newsData, embedding);
      logger.info(`Successfully stored content: ${documentId} - ${fullContent.title}`);

      return true;

    } catch (error) {
      logger.error(`Failed to process article "${article.title}":`, error);
      return false;
    }
  }

  /**
   * Main processing method
   */
  async processWiskSpecificData(): Promise<any> {
    logger.info('Processing Wisk Aero specific data...');
    
    try {
      await this.initializeNewsBrowser();
      
      // Navigate to newsroom page
      logger.info(`Navigating to Wisk newsroom: ${this.NEWSROOM_BASE_URL}`);
      let navigationSuccess = false;
      let retries = 3;
      
      while (retries > 0 && !navigationSuccess) {
        try {
          await this.newsPage!.goto(this.NEWSROOM_BASE_URL);
          navigationSuccess = true;
          logger.info('Successfully navigated to Wisk newsroom');
        } catch (error) {
          retries--;
          logger.warn(`Navigation failed, retries remaining: ${retries}`);
          if (retries > 0) {
            await this.delay(3000);
          } else {
            throw error;
          }
        }
      }
      
      // Handle cookie consent
      await this.handleWiskCookieConsent();
      
      // Wait for content to load
      try {
        await this.newsPage!.waitForSelector('#press, #blogs, #news', { timeout: 15000 });
      } catch {}
      
      await this.delay(2000);
      
      // Define sections to process
      const sections = [
        { id: 'press', name: 'Press Releases', category: 'Press Release' },
        { id: 'blogs', name: 'Blog & White Papers', category: 'Blog' },
        { id: 'news', name: 'News Coverage', category: 'News Coverage' }
      ];
      
      const sectionResults = [];
      let totalProcessed = 0;
      let totalSkipped = 0;
      let totalFailed = 0;
      const allProcessedDocuments = [];
      
      // Process each section
      for (const section of sections) {
        logger.info(`\n=== Processing ${section.name} ===`);
        
        // Scroll to section to ensure it's visible
        await this.newsPage!.evaluate((sectionId) => {
          // @ts-ignore - browser context
          const section = document.querySelector(`#${sectionId}`);
          if (section) {
            section.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }, section.id);
        
        await this.delay(1000);
        
        // Click "Load More" until all articles are loaded
        await this.loadMoreArticlesForSection(section.id, section.name);
        
        // Extract all articles from this section
        const articles = await this.extractArticlesFromSection(section.id, section.name, section.category);
        
        logger.info(`Found ${articles.length} articles in ${section.name}`);
        
        let processedCount = 0;
        let skippedCount = 0;
        let failedCount = 0;
        
        // Process each article
        for (const article of articles) {
          try {
            logger.info(`[${section.name}] Processing: ${article.title}`);
            
            const processed = await this.processAndStoreArticle(article);
            
            if (processed) {
              processedCount++;
              allProcessedDocuments.push({
                url: article.url,
                title: article.title,
                publishedDate: article.publishedDate,
                categories: article.categories
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
        
        sectionResults.push({
          section: section.name,
          total: articles.length,
          processed: processedCount,
          skipped: skippedCount,
          failed: failedCount
        });
        
        totalProcessed += processedCount;
        totalSkipped += skippedCount;
        totalFailed += failedCount;
        
        logger.info(`${section.name} complete: ${processedCount} processed, ${skippedCount} skipped, ${failedCount} failed`);
      }
      
      // Cleanup browser
      await this.cleanupNewsBrowser();
      
      // Return summary
      const wiskSummary = {
        company: 'Wisk Aero',
        aircraft: ['Generation 6 Autonomous eVTOL'],
        totalDocuments: allProcessedDocuments.length,
        processed: totalProcessed,
        skipped: totalSkipped,
        failed: totalFailed,
        sectionResults,
        documents: allProcessedDocuments
      };

      logger.info(`\n=== Wisk Aero processing complete ===`);
      logger.info(`Total: ${totalProcessed} processed, ${totalSkipped} skipped, ${totalFailed} failed`);
      sectionResults.forEach(result => {
        logger.info(`  ${result.section}: ${result.processed}/${result.total} processed`);
      });
      
      return wiskSummary;

    } catch (error) {
      logger.error('Failed to process Wisk Aero data:', error);
      throw error;
    }
  }
}

// Export singleton instance
export const wiskAeroService = new WiskAeroService();

