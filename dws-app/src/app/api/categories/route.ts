import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import type { Category } from '@/lib/types';

export async function GET() {
  const supabase = await createSupabaseServerClient();

  try {
    const { data: categories, error } = await supabase
      .from('categories')
      .select('id, name, created_at')
      .order('name', { ascending: true });

    if (error) {
      return NextResponse.json({ error: error.message || 'Failed to fetch categories' }, { status: 500 });
    }

    if (!categories) {
      return NextResponse.json({ success: true, categories: [] }, { status: 200 });
    }

    return NextResponse.json({ success: true, categories: categories as Category[] }, { status: 200 });

  } catch (error) {
    console.error('Error processing fetch categories request:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: `Error processing request: ${errorMessage}` }, { status: 500 });
  }
}
