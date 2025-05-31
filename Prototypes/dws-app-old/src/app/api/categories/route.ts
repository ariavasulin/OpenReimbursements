import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import type { Category } from '@/lib/types';

export async function GET(request: Request) {
  const supabase = await createSupabaseServerClient();

  // For fetching public categories, session check might be optional,
  // but it's included here for consistency if policies were to change.
  // const { data: { session } } = await supabase.auth.getSession();
  // if (!session) {
  //   return NextResponse.json({ error: 'Unauthorized to fetch categories' }, { status: 401 });
  // }

  try {
    const { data: categories, error } = await supabase
      .from('categories')
      .select('id, name, created_at') // Ensure these columns exist
      .order('name', { ascending: true }); // Order by name for consistent dropdown

    if (error) {
      console.error('Error fetching categories:', error);
      return NextResponse.json({ error: error.message || 'Failed to fetch categories' }, { status: 500 });
    }

    if (!categories) {
      // This case should ideally not happen if the table exists but is empty.
      // .select() on an empty table returns [], not null.
      return NextResponse.json({ success: true, categories: [] }, { status: 200 });
    }

    return NextResponse.json({ success: true, categories: categories as Category[] }, { status: 200 });

  } catch (error) {
    console.error('Error processing fetch categories request:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: `Error processing request: ${errorMessage}` }, { status: 500 });
  }
}