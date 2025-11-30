import { jobyAviationService } from './services/jobyAviationService';
import { archerAviationService } from './services/archerAviationService';
import logger from './utils/logger';

// Service registry - maps SERVICE_NAME to service and method
const SERVICE_REGISTRY: Record<string, { service: any; method: string; name: string }> = {
  'joby': {
    service: jobyAviationService,
    method: 'processJobySpecificData',
    name: 'Joby Aviation'
  },
  'archer': {
    service: archerAviationService,
    method: 'processArcherSpecificData',
    name: 'Archer Aviation'
  },
  // Add more services here as they're implemented
  // 'beta': {
  //   service: betaTechnologiesService,
  //   method: 'processBetaSpecificData',
  //   name: 'Beta Technologies'
  // },
};

async function runService(serviceKey: string) {
  const serviceConfig = SERVICE_REGISTRY[serviceKey];
  if (!serviceConfig) {
    throw new Error(`Unknown service: ${serviceKey}. Available services: ${Object.keys(SERVICE_REGISTRY).join(', ')}`);
  }

  logger.info(`=== ${serviceConfig.name} Cron Job Started ===`);
  logger.info(`Started at: ${new Date().toISOString()}`);
  
  try {
    const result = await serviceConfig.service[serviceConfig.method]();
    
    logger.info(`=== ${serviceConfig.name} Cron Job Completed Successfully ===`);
    logger.info(`Company: ${result.company || 'N/A'}`);
    logger.info(`Processed: ${result.processed || 0}`);
    logger.info(`Skipped: ${result.skipped || 0}`);
    logger.info(`Failed: ${result.failed || 0}`);
    logger.info(`Total Documents: ${result.totalDocuments || 0}`);
    logger.info(`Completed at: ${new Date().toISOString()}`);
    
    if (result.categoryResults && result.categoryResults.length > 0) {
      logger.info('\nCategory Results:');
      result.categoryResults.forEach((cat: any) => {
        logger.info(`  ${cat.category}: ${cat.processed}/${cat.total} processed`);
      });
    }
    
    return { success: true, result };
  } catch (error) {
    logger.error(`=== ${serviceConfig.name} Cron Job Failed ===`);
    logger.error('Error:', error);
    logger.error(`Failed at: ${new Date().toISOString()}`);
    throw error;
  }
}

async function runAllServices() {
  logger.info('=== EVTOL News Cron Job Started (All Services) ===');
  logger.info(`Started at: ${new Date().toISOString()}`);
  
  const results: Array<{ service: string; success: boolean; error?: string }> = [];
  
  for (const [key, config] of Object.entries(SERVICE_REGISTRY)) {
    try {
      logger.info(`\n=== Processing ${config.name} ===`);
      await runService(key);
      results.push({ service: config.name, success: true });
      logger.info(`${config.name} completed successfully`);
    } catch (error) {
      logger.error(`${config.name} failed:`, error);
      results.push({ 
        service: config.name, 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      // Continue with other services even if one fails
    }
    
    // Delay between services
    if (Object.keys(SERVICE_REGISTRY).indexOf(key) < Object.keys(SERVICE_REGISTRY).length - 1) {
      logger.info('Waiting 5 seconds before next service...');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  
  logger.info('\n=== All Services Completed ===');
  results.forEach(r => {
    logger.info(`${r.service}: ${r.success ? '✅ Success' : '❌ Failed'}`);
    if (r.error) {
      logger.error(`  Error: ${r.error}`);
    }
  });
  
  const allSuccess = results.every(r => r.success);
  return allSuccess;
}

async function main() {
  const serviceName = (process.env.SERVICE_NAME || 'joby').toLowerCase();
  
  logger.info(`Service name from environment: ${serviceName}`);
  logger.info(`Available services: ${Object.keys(SERVICE_REGISTRY).join(', ')}, all`);
  
  try {
    if (serviceName === 'all') {
      logger.info('Running all services...');
      const success = await runAllServices();
      process.exit(success ? 0 : 1);
    } else {
      logger.info(`Running single service: ${serviceName}`);
      await runService(serviceName);
      process.exit(0);
    }
  } catch (error) {
    logger.error('Cron job failed:', error);
    process.exit(1);
  }
}

// Run the import
main();

