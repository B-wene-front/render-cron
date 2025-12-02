import { supabase } from '../config/database';
import logger from './logger';

/**
 * Tracks consecutive duplicate articles to optimize crawling.
 * Stops processing when encountering 5 consecutive duplicates,
 * indicating we've reached articles that have already been processed.
 */
export class DuplicateTracker {
  private consecutiveDuplicates: number = 0;
  private readonly maxConsecutiveDuplicates: number;
  private readonly tableName: string;

  /**
   * @param maxConsecutiveDuplicates - Number of consecutive duplicates before stopping (default: 5)
   * @param tableName - Database table name to check (default: 'news')
   */
  constructor(maxConsecutiveDuplicates: number = 5, tableName: string = 'news') {
    this.maxConsecutiveDuplicates = maxConsecutiveDuplicates;
    this.tableName = tableName;
  }

  /**
   * Check if a URL already exists in the database
   * @param url - Article URL to check
   * @returns Promise<boolean> - true if duplicate exists, false otherwise
   */
  async checkDuplicate(url: string): Promise<boolean> {
    try {
      const { count } = await supabase
        .from(this.tableName)
        .select('*', { count: 'exact', head: true })
        .eq('url', url);

      return (count || 0) > 0;
    } catch (error) {
      logger.warn(`Failed to check if record exists for URL ${url}:`, error);
      // On error, assume it's not a duplicate to avoid false positives
      return false;
    }
  }

  /**
   * Process a duplicate check and track consecutive duplicates.
   * Resets counter when a new article is found.
   * @param url - Article URL to check
   * @returns Promise<{ isDuplicate: boolean; shouldStop: boolean }>
   */
  async processCheck(url: string): Promise<{ isDuplicate: boolean; shouldStop: boolean }> {
    const isDuplicate = await this.checkDuplicate(url);

    if (isDuplicate) {
      this.consecutiveDuplicates++;
      logger.info(
        `Duplicate found (${this.consecutiveDuplicates}/${this.maxConsecutiveDuplicates} consecutive): ${url}`
      );

      if (this.consecutiveDuplicates >= this.maxConsecutiveDuplicates) {
        logger.info(
          `Reached ${this.maxConsecutiveDuplicates} consecutive duplicates. Stopping processing - no more new articles.`
        );
        return { isDuplicate: true, shouldStop: true };
      }
    } else {
      // Reset counter when we find a new article
      if (this.consecutiveDuplicates > 0) {
        logger.info(
          `New article found after ${this.consecutiveDuplicates} duplicates. Resetting counter.`
        );
      }
      this.consecutiveDuplicates = 0;
    }

    return { isDuplicate, shouldStop: false };
  }

  /**
   * Reset the consecutive duplicate counter
   */
  reset(): void {
    this.consecutiveDuplicates = 0;
  }

  /**
   * Get current consecutive duplicate count
   */
  getConsecutiveCount(): number {
    return this.consecutiveDuplicates;
  }

  /**
   * Check if we should stop based on current count
   */
  shouldStop(): boolean {
    return this.consecutiveDuplicates >= this.maxConsecutiveDuplicates;
  }
}

/**
 * Factory function to create a DuplicateTracker instance
 * @param maxConsecutiveDuplicates - Number of consecutive duplicates before stopping (default: 5)
 * @param tableName - Database table name to check (default: 'news')
 */
export function createDuplicateTracker(
  maxConsecutiveDuplicates: number = 5,
  tableName: string = 'news'
): DuplicateTracker {
  return new DuplicateTracker(maxConsecutiveDuplicates, tableName);
}

