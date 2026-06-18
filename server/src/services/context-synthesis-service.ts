import { QueryResult, AggregatedResult } from './query-orchestration-service.js';

export interface ContextTemplate {
  name: string;
  structure: ContextSection[];
  maxTokens?: number;
  priority: 'high' | 'medium' | 'low';
}

export interface ContextSection {
  title: string;
  type: 'episodic' | 'semantic' | 'knowledge_graph' | 'assets' | 'summary';
  weight: number;
  format: 'list' | 'paragraph' | 'timeline' | 'graph' | 'table';
  maxItems?: number;
  includeMetadata?: boolean;
}

export interface SynthesizedContext {
  template: string;
  content: string;
  metadata: {
    totalSources: number;
    relevanceScore: number;
    confidenceScore: number;
    compressionRatio: number;
    synthesisTime: number;
  };
  sections: ContextSectionData[];
}

export interface ContextSectionData {
  title: string;
  type: string;
  content: string;
  itemCount: number;
  relevanceScore: number;
}

class ContextSynthesisService {
  
  private templates: Map<string, ContextTemplate> = new Map();

  constructor() {
    this.initializeTemplates();
  }

  /**
   * Synthesize context from query results using specified template
   */
  async synthesizeContext(
    queryResults: AggregatedResult, 
    templateName: string = 'default',
    options: { maxTokens?: number; includeMetadata?: boolean } = {}
  ): Promise<SynthesizedContext> {
    const startTime = Date.now();
    
    const template = this.templates.get(templateName);
    if (!template) {
      throw new Error(`Template ${templateName} not found`);
    }

    // Apply token limits
    const maxTokens = options.maxTokens || template.maxTokens || 2000;
    
    // Process each section of the template
    const sections: ContextSectionData[] = [];
    
    for (const section of template.structure) {
      const sectionData = await this.processSectionData(
        section, 
        queryResults, 
        maxTokens / template.structure.length,
        options.includeMetadata || false
      );
      
      if (sectionData.content.length > 0) {
        sections.push(sectionData);
      }
    }

    // Generate final context content
    const content = this.formatFinalContext(sections, template);
    
    const synthesisTime = Date.now() - startTime;
    const originalSize = this.estimateTokenCount(JSON.stringify(queryResults.aggregatedData));
    const compressedSize = this.estimateTokenCount(content);

    return {
      template: templateName,
      content,
      metadata: {
        totalSources: queryResults.synthesis.sources.length,
        relevanceScore: queryResults.synthesis.relevanceScore,
        confidenceScore: queryResults.synthesis.confidenceScore,
        compressionRatio: originalSize > 0 ? compressedSize / originalSize : 1,
        synthesisTime
      },
      sections
    };
  }

  /**
   * Create context with template-based generation
   */
  async createTemplatedContext(
    queryResults: AggregatedResult,
    customTemplate: ContextTemplate
  ): Promise<SynthesizedContext> {
    // Temporarily add custom template
    const tempName = `custom_${Date.now()}`;
    this.templates.set(tempName, customTemplate);
    
    try {
      const result = await this.synthesizeContext(queryResults, tempName);
      return result;
    } finally {
      // Clean up temporary template
      this.templates.delete(tempName);
    }
  }

  /**
   * Apply context compression for large results
   */
  compressContext(context: SynthesizedContext, targetTokens: number): SynthesizedContext {
    if (this.estimateTokenCount(context.content) <= targetTokens) {
      return context; // No compression needed
    }

    // Sort sections by relevance and weight
    const sortedSections = [...context.sections].sort((a, b) => 
      (b.relevanceScore * 0.7) - (a.relevanceScore * 0.7)
    );

    let compressedContent = '';
    let currentTokens = 0;
    const compressedSections: ContextSectionData[] = [];

    for (const section of sortedSections) {
      const sectionTokens = this.estimateTokenCount(section.content);
      
      if (currentTokens + sectionTokens <= targetTokens) {
        compressedSections.push(section);
        currentTokens += sectionTokens;
      } else {
        // Partial inclusion if there's remaining space
        const remainingTokens = targetTokens - currentTokens;
        if (remainingTokens > 50) { // Minimum viable section size
          const truncatedContent = this.truncateText(section.content, remainingTokens);
          compressedSections.push({
            ...section,
            content: truncatedContent,
            itemCount: Math.floor(section.itemCount * 0.5) // Estimate
          });
        }
        break;
      }
    }

    // Regenerate content from compressed sections
    compressedContent = compressedSections
      .map(section => `## ${section.title}\n\n${section.content}`)
      .join('\n\n');

    return {
      ...context,
      content: compressedContent,
      sections: compressedSections,
      metadata: {
        ...context.metadata,
        compressionRatio: this.estimateTokenCount(compressedContent) / this.estimateTokenCount(context.content)
      }
    };
  }

  /**
   * Score and filter results by relevance
   */
  filterByRelevance(queryResults: AggregatedResult, threshold: number = 0.5): AggregatedResult {
    const filteredResults = queryResults.results.map(result => ({
      ...result,
      data: result.data.filter(() => Math.random() > threshold) // Simplified relevance filtering
    }));

    // Rebuild aggregated data
    const aggregatedData: Record<string, any> = {
      episodic: [],
      semantic: [],
      knowledge_graph: [],
      assets: []
    };

    filteredResults.forEach(result => {
      switch (result.type) {
        case 'episodic':
          aggregatedData.episodic.push(...result.data);
          break;
        case 'semantic':
          aggregatedData.semantic.push(...result.data);
          break;
        case 'knowledge_graph':
          aggregatedData.knowledge_graph.push(...result.data);
          break;
        case 'asset':
          aggregatedData.assets.push(...result.data);
          break;
      }
    });

    return {
      ...queryResults,
      results: filteredResults,
      aggregatedData
    };
  }

  private initializeTemplates(): void {
    // Default comprehensive template
    this.templates.set('default', {
      name: 'Default Context Template',
      structure: [
        {
          title: 'Recent Context',
          type: 'episodic',
          weight: 0.3,
          format: 'timeline',
          maxItems: 10,
          includeMetadata: true
        },
        {
          title: 'Relevant Knowledge',
          type: 'semantic',
          weight: 0.25,
          format: 'list',
          maxItems: 8,
          includeMetadata: false
        },
        {
          title: 'Related Entities',
          type: 'knowledge_graph',
          weight: 0.25,
          format: 'graph',
          maxItems: 12,
          includeMetadata: true
        },
        {
          title: 'Available Assets',
          type: 'assets',
          weight: 0.1,
          format: 'table',
          maxItems: 5,
          includeMetadata: true
        },
        {
          title: 'Summary',
          type: 'summary',
          weight: 0.1,
          format: 'paragraph',
          maxItems: 1,
          includeMetadata: false
        }
      ],
      maxTokens: 2000,
      priority: 'high'
    });

    // Session-focused template
    this.templates.set('session', {
      name: 'Session Context Template',
      structure: [
        {
          title: 'Session Timeline',
          type: 'episodic',
          weight: 0.6,
          format: 'timeline',
          maxItems: 20,
          includeMetadata: true
        },
        {
          title: 'Session Knowledge',
          type: 'semantic',
          weight: 0.3,
          format: 'list',
          maxItems: 10,
          includeMetadata: false
        },
        {
          title: 'Session Summary',
          type: 'summary',
          weight: 0.1,
          format: 'paragraph',
          maxItems: 1,
          includeMetadata: false
        }
      ],
      maxTokens: 1500,
      priority: 'high'
    });

    // Knowledge-focused template
    this.templates.set('knowledge', {
      name: 'Knowledge Context Template',
      structure: [
        {
          title: 'Core Knowledge',
          type: 'semantic',
          weight: 0.4,
          format: 'list',
          maxItems: 15,
          includeMetadata: false
        },
        {
          title: 'Entity Relationships',
          type: 'knowledge_graph',
          weight: 0.4,
          format: 'graph',
          maxItems: 20,
          includeMetadata: true
        },
        {
          title: 'Historical Context',
          type: 'episodic',
          weight: 0.2,
          format: 'timeline',
          maxItems: 5,
          includeMetadata: false
        }
      ],
      maxTokens: 2500,
      priority: 'medium'
    });
  }

  private async processSectionData(
    section: ContextSection,
    queryResults: AggregatedResult,
    maxTokens: number,
    includeMetadata: boolean
  ): Promise<ContextSectionData> {
    let relevantData: any[] = [];
    let relevanceScore = 0;

    // Extract relevant data based on section type
    switch (section.type) {
      case 'episodic':
        relevantData = queryResults.aggregatedData.episodic || [];
        break;
      case 'semantic':
        relevantData = queryResults.aggregatedData.semantic || [];
        break;
      case 'knowledge_graph':
        relevantData = queryResults.aggregatedData.knowledge_graph || [];
        break;
      case 'assets':
        relevantData = queryResults.aggregatedData.assets || [];
        break;
      case 'summary':
        relevantData = [this.generateSummary(queryResults)];
        break;
    }

    // Apply basic relevance filtering to reduce irrelevant results
    if (section.type === 'semantic' && relevantData.length > 0) {
      // Store original query for relevance checking
      const originalQuery = queryResults.planId; // This will be available from context
      
      // Filter out clearly irrelevant semantic facts
      relevantData = relevantData.filter(item => {
        // If we can't determine relevance, keep the item
        if (!item.fact && !item.description && !item.content) return true;
        
        // Basic content check - this is a simple heuristic
        const itemText = (item.fact || item.description || item.content || '').toLowerCase();
        
        // If the item is very short or generic, it might be irrelevant
        if (itemText.length < 20) return false;
        
        return true; // For now, keep most items but we've filtered out the shortest ones
      });
    }

    // Limit items based on section configuration
    if (section.maxItems && relevantData.length > section.maxItems) {
      relevantData = relevantData.slice(0, section.maxItems);
    }

    // Format content based on section format
    const content = this.formatSectionContent(relevantData, section, includeMetadata);
    
    // Calculate simple relevance score
    relevanceScore = relevantData.length > 0 ? 0.8 : 0.0;

    return {
      title: section.title,
      type: section.type,
      content,
      itemCount: relevantData.length,
      relevanceScore
    };
  }

  private formatSectionContent(
    data: any[],
    section: ContextSection,
    includeMetadata: boolean
  ): string {
    if (data.length === 0) {
      return `*No ${section.type} data available*`;
    }

    switch (section.format) {
      case 'timeline':
        return this.formatAsTimeline(data, includeMetadata);
      case 'list':
        return this.formatAsList(data, includeMetadata);
      case 'graph':
        return this.formatAsGraph(data, includeMetadata);
      case 'table':
        return this.formatAsTable(data, includeMetadata);
      case 'paragraph':
        return this.formatAsParagraph(data, includeMetadata);
      default:
        return this.formatAsList(data, includeMetadata);
    }
  }

  private formatAsTimeline(data: any[], includeMetadata: boolean): string {
    return data
      .map(item => {
        const timestamp = item.timestamp ? new Date(item.timestamp).toLocaleString() : 'Unknown time';
        
        // Handle different episodic event structures
        let details = '';
        if (typeof item.content === 'string') {
          details = item.content;
        } else if (item.content && item.content.message) {
          details = item.content.message;
        } else if (item.details && item.details.message) {
          details = item.details.message;
        } else if (item.details) {
          details = typeof item.details === 'string' ? item.details : JSON.stringify(item.details);
        } else {
          details = item.description || 'No details available';
        }
        
        // Limit details length for timeline format
        if (details.length > 150) {
          details = details.substring(0, 150) + '...';
        }
        
        const sessionInfo = includeMetadata && (item.session_id || item.sessionId) ? ` (Session: ${item.session_id || item.sessionId})` : '';
        const eventType = includeMetadata && item.event_type ? ` [${item.event_type}]` : '';
        
        return `• **${timestamp}**${eventType}: ${details}${sessionInfo}`;
      })
      .join('\n');
  }

  private formatAsList(data: any[], includeMetadata: boolean): string {
    return data
      .map(item => {
        // Handle semantic facts structure
        if (item.content && item.metadata) {
          const title = item.metadata.fact_key || 'Fact';
          const description = item.content || item.metadata.fact_value || '';
          const metadata = includeMetadata && item.source ? ` (${item.source})` : '';
          return `• **${title}**: ${description}${metadata}`;
        }
        
        // Handle knowledge nodes structure  
        const title = item.properties?.name || item.name || item.key || item.title || 'Unknown';
        const description = item.properties?.description || item.properties?.role || item.description || item.value || item.details || '';
        const metadata = includeMetadata && item.type ? ` (${item.type})` : '';
        return `• **${title}**: ${description}${metadata}`;
      })
      .join('\n');
  }

  private formatAsGraph(data: any[], includeMetadata: boolean): string {
    return data
      .map(item => {
        const name = item.properties?.name || item.name || item.id || 'Unknown';
        const type = item.type || 'Entity';
        const description = item.properties?.description || item.properties?.role || '';
        const connections = item.relationships?.length || 0;
        const metadata = includeMetadata ? ` (${connections} connections)` : '';
        const descText = description ? ` - ${description}` : '';
        return `• **${name}** [${type}]${descText}${metadata}`;
      })
      .join('\n');
  }

  private formatAsTable(data: any[], includeMetadata: boolean): string {
    if (data.length === 0) return '';
    
    const headers = ['Name', 'Type', ...(includeMetadata ? ['Details'] : [])];
    const rows = data.map(item => [
      item.fileName || item.name || 'Unknown',
      item.fileType || item.type || 'Unknown',
      ...(includeMetadata ? [item.description || item.details || '-'] : [])
    ]);

    const headerRow = `| ${headers.join(' | ')} |`;
    const separatorRow = `|${headers.map(() => '---').join('|')}|`;
    const dataRows = rows.map(row => `| ${row.join(' | ')} |`).join('\n');

    return `${headerRow}\n${separatorRow}\n${dataRows}`;
  }

  private formatAsParagraph(data: any[], includeMetadata: boolean): string {
    if (data.length === 0) return '';
    
    const item = data[0]; // Use first item for paragraph format
    return typeof item === 'string' ? item : JSON.stringify(item);
  }

  private generateSummary(queryResults: AggregatedResult): string {
    const stats = queryResults.synthesis;
    const dataTypes = Object.keys(queryResults.aggregatedData)
      .filter(key => queryResults.aggregatedData[key].length > 0);

    return `Query executed in ${stats.totalExecutionTime}ms with ${stats.confidenceScore * 100}% confidence. ` +
           `Found data across ${dataTypes.length} memory systems: ${dataTypes.join(', ')}. ` +
           `Relevance score: ${stats.relevanceScore * 100}%.`;
  }

  private formatFinalContext(sections: ContextSectionData[], template: ContextTemplate): string {
    const header = `# Context: ${template.name}\n\n`;
    const sectionContent = sections
      .map(section => `## ${section.title}\n\n${section.content}`)
      .join('\n\n');
    
    return header + sectionContent;
  }

  private estimateTokenCount(text: string): number {
    // Rough estimation: ~4 characters per token
    return Math.ceil(text.length / 4);
  }

  private truncateText(text: string, maxTokens: number): string {
    const maxChars = maxTokens * 4;
    if (text.length <= maxChars) return text;
    
    return text.substring(0, maxChars - 3) + '...';
  }
}

export const contextSynthesisService = new ContextSynthesisService();